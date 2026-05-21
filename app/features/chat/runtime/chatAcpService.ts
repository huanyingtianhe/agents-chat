import type { MutableRefObject } from 'react';
import type { Agent } from '../../agents/agentTypes';
import type { ChatAttachment } from '../../composer/attachmentTypes';
import type { AgentUserRequest, ChatMessage, ContentPart, OrchestrationState, SessionRunContext } from '../chatTypes';
import { getAcpTurnProgressSignature } from '../chatHelpers';
import { mapTurnPhase, makeId, PromptSendFailedError } from './chatRunLoop';

export type FileCommentCallbacks = {
  extractFileComments: (text: string, agentId: string) => { cleanText: string; comments: any[] };
  saveAgentComments: (agentId: string, comments: any[], agentName?: string) => Promise<void>;
  fileCommentsRef: MutableRefObject<any[]>;
  resolveProcessingCommentForChat: (chatId: string, commentId: string) => Promise<void>;
};

export type AcpServiceContext = {
  acp: (body: Record<string, unknown>) => Promise<any>;
  sessionRunsRef: MutableRefObject<Record<string, SessionRunContext>>;
  orchestrationsRef: MutableRefObject<Record<string, OrchestrationState>>;
  currentChatIdRef: MutableRefObject<string>;
  currentAgentSessionsRef: MutableRefObject<Record<string, string>>;
  needsContextRestoreRef: MutableRefObject<boolean>;
  chatMessagesRef: MutableRefObject<Record<string, ChatMessage[]>>;
  messagesRef: MutableRefObject<ChatMessage[]>;
  agentsRef: MutableRefObject<Agent[]>;
  getSelectedModelIdForAgent: (agentId: string) => string;
  updateMessage: (id: string, patch: Partial<ChatMessage>, chatId?: string) => void;
  addMessage: (msg: Omit<ChatMessage, 'id' | 'ts'> & { id?: string; ts?: number }, chatId?: string) => string;
  removeMessage: (id: string, chatId?: string) => void;
  notifyRunStateChanged: () => void;
  maybeAdvanceOrchestration: (orchestrationId: string) => Promise<void>;
  fileCommentCallbacksRef: MutableRefObject<FileCommentCallbacks | null>;
};

export function createAcpHandlers(ctx: AcpServiceContext) {
  function isChatRunning(chatId: string) {
    return Object.values(ctx.sessionRunsRef.current).some((run) => run.chatId === chatId);
  }

  function finalizeRun(runKey: string) {
    const run = ctx.sessionRunsRef.current[runKey];
    if (!run) return;
    ctx.updateMessage(run.pendingId, { pending: false, statusText: undefined, ptyPhase: undefined }, run.chatId);
    const orchestration = ctx.orchestrationsRef.current[run.orchestrationId];
    if (orchestration && run.kind === 'worker') {
      orchestration.results[run.agentId] = run.currentText || '';
    }
    delete ctx.sessionRunsRef.current[runKey];
    ctx.notifyRunStateChanged();
    if (orchestration && run.kind === 'worker') {
      void ctx.maybeAdvanceOrchestration(run.orchestrationId);
    }
  }

  function resumeActiveTurn(
    agentId: string,
    turn: { messageId?: string; fullText?: string; phase?: string; statusText?: string; userRequest?: AgentUserRequest },
  ) {
    const resumeChatId = ctx.currentChatIdRef.current;
    const pendingId = turn.messageId || `pending-${makeId()}`;
    const existing = (ctx.chatMessagesRef.current[resumeChatId] || ctx.messagesRef.current).find((m) => m.id === pendingId);
    const statusText = turn.statusText || existing?.statusText || 'Thinking';
    const ptyPhase = mapTurnPhase(turn.phase || (existing?.ptyPhase as string) || 'thinking');
    const userRequest = turn.userRequest || existing?.userRequest;
    if (existing) {
      ctx.updateMessage(pendingId, { pending: true, agentId, content: turn.fullText || existing.content || '', statusText, ptyPhase, userRequest }, resumeChatId);
    } else {
      ctx.addMessage({ id: pendingId, type: 'agent', content: turn.fullText || '', agentId, pending: true, statusText, ptyPhase, userRequest }, resumeChatId);
    }
    const runKey = `acp:${agentId}:${resumeChatId}`;
    if (!ctx.sessionRunsRef.current[runKey]) {
      ctx.sessionRunsRef.current[runKey] = {
        agentId,
        pendingId,
        orchestrationId: `orch-resume-${makeId()}`,
        kind: 'worker',
        currentText: turn.fullText || '',
        chatId: resumeChatId,
      };
      ctx.notifyRunStateChanged();
      void pollAcpAgent(agentId, resumeChatId);
    }
  }

  async function sendAcpPrompt(
    runKey: string,
    agentId: string,
    pendingId: string,
    content: string,
    promptAttachments: ChatAttachment[] = [],
  ) {
    const run = ctx.sessionRunsRef.current[runKey];
    if (!run || run.ptySendStarted) return false;
    run.ptySendStarted = true;
    ctx.updateMessage(pendingId, { statusText: 'Connecting', pending: true, ptyPhase: 'loading-environment' }, run.chatId);
    const sendChatId = run.chatId;
    const sendBody: Record<string, unknown> = {
      action: 'send', agentId, text: content, chatId: sendChatId, messageId: pendingId,
    };
    sendBody.modelId = ctx.getSelectedModelIdForAgent(agentId);
    if (promptAttachments.length > 0) sendBody.attachments = promptAttachments;
    if (ctx.needsContextRestoreRef.current) {
      const historyMessages = ctx.chatMessagesRef.current[sendChatId]
        || (sendChatId === ctx.currentChatIdRef.current ? ctx.messagesRef.current : []);
      sendBody.chatHistory = historyMessages
        .filter((m) => m.type === 'user' || m.type === 'agent')
        .slice(-20)
        .map((m) => ({ type: m.type, content: m.content, agentId: m.agentId }));
      ctx.needsContextRestoreRef.current = false;
    }
    const sendResult = await ctx.acp(sendBody);
    const current = ctx.sessionRunsRef.current[runKey];
    if (!current) return false;
    if (sendResult && !sendResult.ok) {
      throw new PromptSendFailedError(sendResult.error || 'Failed to send prompt to agent');
    }
    if (sendResult?.sessionId) {
      ctx.currentAgentSessionsRef.current = { ...ctx.currentAgentSessionsRef.current, [agentId]: sendResult.sessionId };
    }
    current.ptyTurnId = sendResult?.turn?.id;
    if (sendResult?.phase === 'booting') {
      ctx.updateMessage(pendingId, { statusText: 'Starting environment', ptyPhase: 'loading-environment', pending: true }, sendChatId);
    }
    void pollAcpAgent(agentId, sendChatId);
    return true;
  }

  async function dispatchToAgent(
    agentId: string,
    content: string,
    orchestrationId: string,
    kind: 'worker' | 'summary' = 'worker',
    options?: { round?: number; relation?: string; summary?: boolean; chatId?: string; commentId?: string; attachments?: ChatAttachment[] },
  ): Promise<string> {
    const dispatchChatId = options?.chatId || ctx.currentChatIdRef.current;
    const pendingId = `pending-${makeId()}`;
    const runKey = `acp:${agentId}:${dispatchChatId}`;
    if (ctx.sessionRunsRef.current[runKey]) {
      throw new PromptSendFailedError('Agent is already running in this chat');
    }
    ctx.addMessage({
      id: pendingId, type: 'agent', content: '', agentId, pending: true,
      round: options?.round, relation: options?.relation, summary: options?.summary,
    }, dispatchChatId);
    ctx.sessionRunsRef.current[runKey] = {
      agentId, pendingId, orchestrationId, kind,
      currentText: '', chatId: dispatchChatId,
      commentId: options?.commentId, round: options?.round, relation: options?.relation,
    };
    ctx.notifyRunStateChanged();
    try {
      const sent = await sendAcpPrompt(runKey, agentId, pendingId, content, options?.attachments || []);
      if (!sent) throw new Error('Failed to send prompt to agent');
      return runKey;
    } catch (err) {
      ctx.removeMessage(pendingId, dispatchChatId);
      delete ctx.sessionRunsRef.current[runKey];
      ctx.notifyRunStateChanged();
      throw err;
    }
  }

  async function pollAcpAgent(agentId: string, chatId?: string) {
    const effectiveChatId = chatId || ctx.currentChatIdRef.current;
    const runKey = `acp:${agentId}:${effectiveChatId}`;
    let consecutiveErrors = 0;
    const MAX_ERRORS = 10;
    const POLL_TIMEOUT = 10 * 60_000;
    let lastProgressAt = Date.now();
    let lastProgressSignature = '';

    while (ctx.sessionRunsRef.current[runKey]) {
      const current = ctx.sessionRunsRef.current[runKey];
      if (!current) break;
      if (Date.now() - lastProgressAt > POLL_TIMEOUT) {
        ctx.updateMessage(current.pendingId, {
          content: current.currentText || '⚠️ Response timed out', pending: false, userRequest: undefined,
        }, effectiveChatId);
        finalizeRun(runKey);
        return;
      }
      let result: any;
      try {
        result = await ctx.acp({ action: 'poll', agentId, chatId: effectiveChatId });
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= MAX_ERRORS) {
          ctx.updateMessage(current.pendingId, {
            content: current.currentText || `⚠️ Lost connection to agent (${err instanceof Error ? err.message : 'network error'})`,
            pending: false, userRequest: undefined,
          }, effectiveChatId);
          finalizeRun(runKey);
          return;
        }
        await new Promise((r) => setTimeout(r, 1000 * consecutiveErrors));
        continue;
      }
      consecutiveErrors = 0;

      const turn = result?.activeTurn as {
        fullText?: string; done?: boolean; phase?: string; statusText?: string; error?: string;
        userRequest?: AgentUserRequest;
        events?: {
          type: string; ts: number; toolName?: string; toolCallId?: string;
          toolArgs?: string; toolResult?: string; text?: string;
        }[];
      } | null;

      if (turn) {
        const progressSignature = getAcpTurnProgressSignature(turn);
        if (progressSignature !== lastProgressSignature) { lastProgressSignature = progressSignature; lastProgressAt = Date.now(); }
        const phaseStatusMap: Record<string, string> = { thinking: 'Thinking', tool_exec: 'Executing tool', replying: 'Generating response', booting: 'Starting environment' };
        const statusText = turn.statusText || phaseStatusMap[turn.phase || ''] || '';
        const parts: ContentPart[] = [];
        const toolMap = new Map<string, ContentPart & { kind: 'tool' }>();
        if (turn.events) {
          for (const evt of turn.events) {
            if (evt.type === 'thinking' && evt.text) {
              const last = parts[parts.length - 1];
              if (last && last.kind === 'thinking') { last.text += evt.text; } else { parts.push({ kind: 'thinking', text: evt.text }); }
            } else if (evt.type === 'tool_start' && evt.toolName) {
              const tp: ContentPart & { kind: 'tool' } = { kind: 'tool', toolName: evt.toolName, args: evt.toolArgs, done: false };
              if (evt.toolCallId) toolMap.set(evt.toolCallId, tp);
              parts.push(tp);
            } else if (evt.type === 'tool_complete') {
              const existingTool = evt.toolCallId ? toolMap.get(evt.toolCallId) : null;
              if (existingTool) { existingTool.result = evt.toolResult; existingTool.done = true; }
              else { parts.push({ kind: 'tool', toolName: evt.toolName || 'tool', result: evt.toolResult, done: true }); }
            } else if (evt.type === 'user_response' && evt.text) {
              parts.push({ kind: 'user_answer', text: evt.text });
            } else if (evt.type === 'text_chunk' && evt.text) {
              const last = parts[parts.length - 1];
              if (last && last.kind === 'text') { last.text += evt.text; } else { parts.push({ kind: 'text', text: evt.text }); }
            }
          }
        }
        const serverText = (turn.fullText || '').trim();
        if (turn.done) {
          current.currentText = serverText;
          const fcCbs = ctx.fileCommentCallbacksRef.current;
          if (fcCbs) {
            const { cleanText, comments: agentComments } = fcCbs.extractFileComments(serverText, agentId);
            if (agentComments.length > 0) {
              const agentName = ctx.agentsRef.current.find((a) => a.id === agentId)?.name;
              void fcCbs.saveAgentComments(agentId, agentComments, agentName);
              current.currentText = cleanText;
            }
          }
          const finalContent = current.currentText || (turn.error ? `⚠️ ${turn.error}` : '');
          ctx.updateMessage(current.pendingId, {
            content: finalContent, pending: false,
            parts: parts.length ? parts : undefined,
            userRequest: undefined,
          }, effectiveChatId);
          await ctx.acp({ action: 'turn-clear', agentId, chatId: effectiveChatId }).catch(() => null);
          const completedCommentId = current.commentId;
          finalizeRun(runKey);
          if (effectiveChatId && fcCbs) {
            const fallbackCommentId = fcCbs.fileCommentsRef.current.find(
              (c: any) => c.linkedChatId === effectiveChatId && c.status === 'processing',
            )?.id;
            const commentIdToResolve = completedCommentId || fallbackCommentId;
            if (commentIdToResolve) void fcCbs.resolveProcessingCommentForChat(effectiveChatId, commentIdToResolve);
          }
          return;
        } else {
          const patch: Partial<ChatMessage> = {
            pending: true, ptyPhase: mapTurnPhase(turn.phase || ''),
            statusText: statusText || '', parts: parts.length ? parts : undefined,
            userRequest: turn.userRequest,
          };
          if (serverText) { patch.content = serverText; current.currentText = serverText; }
          ctx.updateMessage(current.pendingId, patch, effectiveChatId);
        }
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }

  return { isChatRunning, finalizeRun, resumeActiveTurn, sendAcpPrompt, dispatchToAgent, pollAcpAgent };
}
