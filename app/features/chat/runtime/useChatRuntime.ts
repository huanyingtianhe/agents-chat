'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Agent } from '../../agents/agentTypes';
import type { ChatAttachment } from '../../composer/attachmentTypes';
import type { AgentUserRequestResponse, ChatHistoryEntry, ChatMessage, DispatchToAgentOptions, OrchestrationMode, OrchestrationState, SessionRunContext, ShareDialog } from '../chatTypes';
import { makeId, PromptSendFailedError } from './chatRunLoop';
import { type FileCommentCallbacks, createAcpHandlers } from './chatAcpService';
import { createOrchestrationHandlers } from './chatOrchestrationService';
import { createPersistenceHandlers } from './chatPersistenceService';
import { getMentionedAgentIds, getDefaultAgentId, getExistingAgentId, parseAgents, normalizeChatHistory, migrateFailedSendWarnings, lastSessionId, getMessageCopyText } from '../chatHelpers';
import { detectWorkflowFollowUp } from '../../orchestration/workflowFollowUp';
import { STORAGE_INPUT_HISTORY } from './sessionPersistence';

export type UseChatRuntimeParams = {
  acp: (body: Record<string, unknown>) => Promise<any>;
  agentsRef: React.MutableRefObject<Agent[]>;
  agentsLoadingRef: React.MutableRefObject<boolean>;
  chatAgentFilterRef: React.MutableRefObject<string | null>;
  getSelectedModelIdForAgent: (agentId: string) => string;
  setInputProgrammatic: (value: string) => void;
  // Resolves the effective "last used agent" for a chat based on the current
  // scope setting: per-user value (any chat) or per-chat value (only the
  // matching chat — no fallback to per-user).
  effectiveLastUsedAgentRef: React.MutableRefObject<(chatId: string) => string | null>;
  rememberLastUsedAgent: (agentId: string, chatId?: string) => void;
  authStatus: string;
  // Called after a send failure that looks like agent-side auth is required,
  // so the agents panel can refresh and surface the red "Sign in" pill.
  reloadAgents?: () => Promise<void> | void;
};

export type PanelCallbacks = {
  setSelectedAgentFilter?: (filter: string | null) => void;
  setShowChatsPanel?: (show: boolean) => void;
  setShowAgentsPanel?: (show: boolean) => void;
  setOpenChatMenuId?: (id: string | null) => void;
  setRenamingChatId?: (id: string | null) => void;
  setRenameValue?: (value: string) => void;
};

export function useChatRuntime({
  acp,
  agentsRef,
  agentsLoadingRef,
  chatAgentFilterRef,
  getSelectedModelIdForAgent,
  setInputProgrammatic,
  effectiveLastUsedAgentRef,
  rememberLastUsedAgent,
  authStatus,
  reloadAgents,
}: UseChatRuntimeParams) {
  /* ── State ── */
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: 'welcome', type: 'system', content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.', ts: 0 },
  ]);
  const [chatHistory, setChatHistory] = useState<ChatHistoryEntry[]>([]);
  const [currentChatId, setCurrentChatId] = useState('');
  const [activeSidebarChatId, setActiveSidebarChatId] = useState('');
  const [chatName, setChatName] = useState('New Chat');
  const [chatCounter, setChatCounter] = useState(1);
  const [runVersion, setRunVersion] = useState(0);
  const [shareDialog, setShareDialog] = useState<ShareDialog | null>(null);
  const [expandedMessages, setExpandedMessages] = useState<Record<string, boolean>>({});
  const [loadedChatIdForResume, setLoadedChatIdForResume] = useState<string | null>(null);
  const [orchestrationMode, setOrchestrationMode] = useState<OrchestrationMode>('auto');
  const [pendingWorkflowPlan, setPendingWorkflowPlan] = useState<import('@/lib/workflow/workflowTypes.mjs').WorkflowPlan | null>(null);
  const [dismissedFollowUpOrchId, setDismissedFollowUpOrchId] = useState<string | null>(null);

  /* ── Refs ── */
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const chatHistoryRef = useRef(chatHistory);
  chatHistoryRef.current = chatHistory;
  const chatMessagesRef = useRef<Record<string, ChatMessage[]>>({});
  const currentChatIdRef = useRef(currentChatId);
  currentChatIdRef.current = currentChatId;
  const chatNameRef = useRef(chatName);
  chatNameRef.current = chatName;
  const sessionRunsRef = useRef<Record<string, SessionRunContext>>({});
  const orchestrationsRef = useRef<Record<string, OrchestrationState>>({});
  const currentAgentSessionsRef = useRef<Record<string, string>>({});
  const needsContextRestoreRef = useRef(false);
  const orchestrationModeRef = useRef(orchestrationMode);
  orchestrationModeRef.current = orchestrationMode;
  const inputHistoryRef = useRef<Record<string, string[]>>({});

  /* ── Cross-service callback refs ── */
  const maybeAdvanceOrchestrationRef = useRef<(id: string) => Promise<void>>(async () => {});
  const dispatchToAgentRef = useRef<(agentId: string, content: string, orchestrationId: string, kind: 'worker' | 'summary', options?: DispatchToAgentOptions) => Promise<string>>(async () => '');
  const resumeActiveTurnRef = useRef<(agentId: string, turn: any) => void>(() => {});

  /* ── Panel callbacks ref — wired by page.tsx after all hooks init ── */
  const panelCallbacksRef = useRef<PanelCallbacks>({});

  /* ── File comments ref — wired by page.tsx ── */
  const fileCommentCallbacksRef = useRef<FileCommentCallbacks | null>(null);

  /* ── Session resume tracking ── */
  const sessionResumedChatIdRef = useRef<string | null>(null);

  /* ── Core message functions ── */
  function setMessagesForChat(chatId: string, nextMessages: ChatMessage[]) {
    chatMessagesRef.current[chatId] = nextMessages;
    if (currentChatIdRef.current === chatId) {
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
    } else {
      notifyRunStateChanged();
    }
  }

  function addMessage(msg: Omit<ChatMessage, 'id' | 'ts'> & { id?: string; ts?: number }, chatId = currentChatIdRef.current): string {
    const next: ChatMessage = { id: msg.id || makeId(), ts: msg.ts || Date.now(), ...msg };
    const base = chatMessagesRef.current[chatId] || (chatId === currentChatIdRef.current ? messagesRef.current : []);
    setMessagesForChat(chatId, [...base, next]);
    return next.id;
  }

  function updateMessage(id: string, patch: Partial<ChatMessage>, chatId = currentChatIdRef.current) {
    const base = chatMessagesRef.current[chatId] || (chatId === currentChatIdRef.current ? messagesRef.current : []);
    setMessagesForChat(chatId, base.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }

  function removeMessage(id: string, chatId = currentChatIdRef.current) {
    const base = chatMessagesRef.current[chatId] || (chatId === currentChatIdRef.current ? messagesRef.current : []);
    setMessagesForChat(chatId, base.filter((m) => m.id !== id));
  }

  function notifyRunStateChanged() {
    setRunVersion((v) => v + 1);
  }

  /* ── ACP service ── */
  const acpHandlers = createAcpHandlers({
    acp, sessionRunsRef, orchestrationsRef, currentChatIdRef, currentAgentSessionsRef,
    needsContextRestoreRef, chatMessagesRef, messagesRef, agentsRef,
    getSelectedModelIdForAgent,
    updateMessage, addMessage, removeMessage, notifyRunStateChanged,
    maybeAdvanceOrchestration: (id) => maybeAdvanceOrchestrationRef.current(id),
    fileCommentCallbacksRef,
  });

  /* ── Orchestration service ── */
  const orchHandlers = createOrchestrationHandlers({
    acp, orchestrationsRef, sessionRunsRef, agentsRef,
    orchestrationModeRef, currentChatIdRef,
    dispatchToAgent: (agentId, content, orchestrationId, kind, options) =>
      dispatchToAgentRef.current(agentId, content, orchestrationId, kind, options),
    markUserMessageSendFailed,
    addMessage, removeMessage, notifyRunStateChanged,
  });

  /* ── Wire cross-service refs ── */
  maybeAdvanceOrchestrationRef.current = orchHandlers.maybeAdvanceOrchestration;
  dispatchToAgentRef.current = acpHandlers.dispatchToAgent;
  resumeActiveTurnRef.current = acpHandlers.resumeActiveTurn;

  /* ── Persistence service ── */
  const persistHandlers = createPersistenceHandlers({
    acp, currentChatIdRef, currentAgentSessionsRef, needsContextRestoreRef,
    chatMessagesRef, messagesRef, chatNameRef, chatAgentFilterRef,
    chatHistoryRef, inputHistoryRef,
    setChatHistory, setChatName, setChatCounter, setCurrentChatId, setActiveSidebarChatId,
    setShareDialog, setExpandedMessages, setMessagesForChat, addMessage,
    resumeActiveTurn: (agentId, turn) => resumeActiveTurnRef.current(agentId, turn),
    onClearInput: () => setInputProgrammatic(''),
    onClearAgentFilter: () => panelCallbacksRef.current.setSelectedAgentFilter?.(null),
    onCloseChatsPanel: () => panelCallbacksRef.current.setShowChatsPanel?.(false),
    onCloseAgentsPanel: () => panelCallbacksRef.current.setShowAgentsPanel?.(false),
  });

  /* ── Failed send helpers ── */
  function looksLikeAgentAuthError(error: string): boolean {
    if (!error) return false;
    return /-32000|authentication required|not authenticated|please.*log.?in|sign.?in required/i.test(error);
  }

  function markUserMessageSendFailed(
    chatId: string, userMessageId: string, error: string,
    resendAgentIds: string[], resendMessage: string, resendAttachments?: ChatAttachment[],
  ) {
    updateMessage(userMessageId, {
      sendStatus: 'failed',
      sendError: error || 'Failed to send prompt to agent',
      resendAgentIds,
      resendMessage,
      attachments: resendAttachments,
    }, chatId);
    void persistHandlers.saveChatToHistory(chatId);
    // If the failure looks like the agent itself needs auth, refresh the
    // agent list so the panel picks up `needsAuth: true` and shows the
    // red "Sign in" pill on the offending agent row.
    if (reloadAgents && looksLikeAgentAuthError(error)) {
      void Promise.resolve(reloadAgents()).catch(() => { /* best effort */ });
    }
  }

  function clearUserMessageSendFailure(chatId: string, userMessageId: string) {
    updateMessage(userMessageId, {
      sendStatus: undefined, sendError: undefined,
      resendAgentIds: undefined, resendMessage: undefined,
    }, chatId);
    void persistHandlers.saveChatToHistory(chatId);
  }

  /* ── Resend / send / stop ── */
  async function resendFailedUserMessage(message: ChatMessage) {
    if (message.type !== 'user' || message.sendStatus !== 'failed') return;
    const chatId = currentChatIdRef.current;
    if (acpHandlers.isChatRunning(chatId)) return;
    if (!message.resendAgentIds?.length && (agentsLoadingRef.current || agentsRef.current.length === 0)) return;
    const parsed = parseAgents(message.content, agentsRef.current);
    const agentIds = message.resendAgentIds?.length ? message.resendAgentIds : parsed.agentIds;
    const resendMessage = message.resendMessage || parsed.message || message.content;
    if (agentIds.length === 0 || !resendMessage.trim()) return;
    clearUserMessageSendFailure(chatId, message.id);
    try {
      await orchHandlers.dispatchParsedPrompt(agentIds, resendMessage, message.content, `resend-${makeId()}`, { chatId, sourceUserMessageId: message.id, attachments: message.attachments || [] });
    } catch (err) {
      markUserMessageSendFailed(chatId, message.id, err instanceof Error ? err.message : String(err), agentIds, resendMessage, message.attachments);
    }
  }

  function retryFailedSend(messageId: string) {
    const message = messagesRef.current.find((m) => m.id === messageId);
    if (message) void resendFailedUserMessage(message);
  }

  async function handleSend(
    text: string,
    sendAttachments: ChatAttachment[],
    inputHistoryIndexRef: React.MutableRefObject<number>,
    inputDraftRef: React.MutableRefObject<string>,
  ) {
    if ((!text && sendAttachments.length === 0) || agentsRef.current.length === 0) return;
    const textForAgent = text || 'Please review the attached file(s).';
    if (!currentChatIdRef.current) {
      await persistHandlers.createNewChat(chatAgentFilterRef.current);
    }
    const sendChatPrimaryAgentId = chatHistory.find(c => c.id === currentChatIdRef.current)?.agentId || null;
    const sendFallbackAgentId = getExistingAgentId(effectiveLastUsedAgentRef.current(currentChatIdRef.current), agentsRef.current)
      || getExistingAgentId(sendChatPrimaryAgentId, agentsRef.current)
      || getDefaultAgentId(agentsRef.current);
    const { agentIds, message } = parseAgents(textForAgent, agentsRef.current, sendFallbackAgentId);
    const explicitlyMentionedAgentIds = getMentionedAgentIds(textForAgent, agentsRef.current);
    if (explicitlyMentionedAgentIds.length > 0) {
      rememberLastUsedAgent(explicitlyMentionedAgentIds[0], currentChatIdRef.current);
    }
    const orchestrationId = `orch-${makeId()}`;
    const sendChatId = currentChatIdRef.current;
    const userMessageId = addMessage({ type: 'user', content: text, attachments: sendAttachments.length ? sendAttachments : undefined }, sendChatId);
    setInputProgrammatic('');
    void persistHandlers.saveChatToHistory(sendChatId);
    const allHist = inputHistoryRef.current;
    if (!allHist[sendChatId]) allHist[sendChatId] = [];
    const chatHist = allHist[sendChatId];
    if (text && chatHist[chatHist.length - 1] !== text) chatHist.push(text);
    if (chatHist.length > 100) chatHist.splice(0, chatHist.length - 100);
    inputHistoryIndexRef.current = -1;
    inputDraftRef.current = '';
    try { window.localStorage.setItem(STORAGE_INPUT_HISTORY, JSON.stringify(allHist)); } catch { /* ignore */ }
    try {
      const followUp = detectWorkflowFollowUp(orchestrationsRef.current, sendChatId);
      const followUpActive = !!followUp && followUp.orchestrationId !== dismissedFollowUpOrchId;
      if (pendingWorkflowPlan && orchestrationMode === 'workflow') {
        const plan = pendingWorkflowPlan;
        setPendingWorkflowPlan(null);
        setOrchestrationMode('auto');
        await orchHandlers.runWorkflowOrchestration(orchestrationId, plan, textForAgent, sendChatId, {
          sourceUserMessageId: userMessageId, attachments: sendAttachments,
        });
      } else if (followUpActive && followUp && explicitlyMentionedAgentIds.length === 0) {
        // Continuation reply: one or more workflow nodes ended with a question
        // and the user typed a reply with no explicit @-mentions. Route the
        // reply only to the agents that asked, in parallel — do NOT spawn a
        // new orchestration / scheduler plan.
        setDismissedFollowUpOrchId(followUp.orchestrationId);
        await Promise.all(followUp.awaitingAgentIds.map((agentId) => acpHandlers.dispatchToAgent(
          agentId, textForAgent, `followup-${makeId()}`, 'worker',
          { chatId: sendChatId, relation: 'Workflow follow-up', attachments: sendAttachments },
        )));
      } else {
        if (orchestrationMode === 'workflow' && !pendingWorkflowPlan) {
          setOrchestrationMode('auto');
        }
        if (followUpActive && followUp) setDismissedFollowUpOrchId(followUp.orchestrationId);
        await orchHandlers.dispatchParsedPrompt(agentIds, message, textForAgent, orchestrationId, { chatId: sendChatId, sourceUserMessageId: userMessageId, attachments: sendAttachments });
      }
    } catch (err) {
      markUserMessageSendFailed(sendChatId, userMessageId, err instanceof Error ? err.message : String(err), agentIds, message || textForAgent, sendAttachments);
    }
  }

  async function sendWorkflowFollowUpReply(text: string, awaitingAgentIds: string[], orchestrationId: string) {
    const trimmed = (text || '').trim();
    if (!trimmed || awaitingAgentIds.length === 0) return;
    const sendChatId = currentChatIdRef.current;
    if (!sendChatId) return;
    addMessage({ type: 'user', content: trimmed }, sendChatId);
    setDismissedFollowUpOrchId(orchestrationId);
    await Promise.all(awaitingAgentIds.map((agentId) => acpHandlers.dispatchToAgent(
      agentId, trimmed, `followup-${makeId()}`, 'worker',
      { chatId: sendChatId, relation: 'Workflow follow-up' },
    )));
  }

  async function handleStop() {
    const stopChatId = currentChatIdRef.current;
    const activeRuns = Object.fromEntries(
      Object.entries(sessionRunsRef.current).filter(([, run]) => run.chatId === stopChatId),
    );
    const agentIds = new Set<string>();
    for (const run of Object.values(activeRuns)) agentIds.add(run.agentId);
    for (const agentId of agentIds) {
      try { await acp({ action: 'interrupt', agentId, chatId: stopChatId }); } catch { /* ignore */ }
    }
    for (const [runKey, run] of Object.entries(activeRuns)) {
      updateMessage(run.pendingId, {
        content: run.currentText || '⏹ Stopped', pending: false,
        statusText: undefined, ptyPhase: undefined, userRequest: undefined,
      }, run.chatId);
      delete sessionRunsRef.current[runKey];
    }
    notifyRunStateChanged();
    orchestrationsRef.current = {};
    addMessage({ type: 'system', content: '⏹ Conversation stopped.' });
    void persistHandlers.saveCurrentChatToHistory();
  }

  async function answerAgentUserRequest(requestId: string, response: AgentUserRequestResponse): Promise<void> {
    const message = messagesRef.current.find((m) => m.userRequest?.id === requestId);
    if (!message?.agentId || !message.userRequest) return;
    const res = await acp({ action: 'respond-user-request', agentId: message.agentId, chatId: currentChatIdRef.current, requestId, ...response });
    if (!res?.ok) throw new Error(res?.error || 'Failed to answer agent request');
  }

  function dismissAgentUserRequest(_requestId: string) { /* no-op currently */ }

  /* ── Mount effect: load last chat + agent sessions ── */
  useEffect(() => {
    try {
      const savedInputHistory = window.localStorage.getItem(STORAGE_INPUT_HISTORY);
      if (savedInputHistory) inputHistoryRef.current = JSON.parse(savedInputHistory) || {};
    } catch { /* ignore */ }
    fetch('/api/chats').then(r => r.json()).then(data => {
      if (data.ok && Array.isArray(data.chats)) setChatHistory(normalizeChatHistory(data.chats));
      const lastChatId = (data.lastChatId as string | null) || (data.chats?.[0]?.id as string | null);
      if (lastChatId) {
        currentChatIdRef.current = lastChatId;
        setCurrentChatId(lastChatId);
        setActiveSidebarChatId(lastChatId);
        fetch(`/api/chats?id=${encodeURIComponent(lastChatId)}`).then(r => r.json()).then(chatData => {
          if (chatData.ok && chatData.chat) {
            const agentSessions = chatData.chat.agentSessions || {};
            const isReviewChat = typeof lastChatId === 'string' && lastChatId.startsWith('comment-review:');
            const migration = migrateFailedSendWarnings(chatData.chat.messages || [], agentSessions, { inferLatestUserFailure: !isReviewChat });
            const msgs = migration.messages;
            currentAgentSessionsRef.current = agentSessions;
            setMessagesForChat(lastChatId, msgs.length > 0 ? msgs : [{ id: 'welcome', type: 'system', content: 'Welcome to Agents Chat. Messages auto-route to the default agent, or type @agent to target a specific one.', ts: 0 }]);
            setChatName(chatData.chat.name || lastChatId);
            needsContextRestoreRef.current = true;
            setLoadedChatIdForResume(lastChatId);
            if (migration.changed) {
              void persistHandlers.persistLoadedChatMigration(lastChatId, chatData.chat.name || lastChatId, chatData.chat.ts || Date.now(), msgs, agentSessions);
            }
            // Backfill input history from loaded messages if none exists for this chat
            if (!inputHistoryRef.current[lastChatId]) {
              const userTexts = msgs.filter((m: ChatMessage) => m.type === 'user' && m.content).map((m: ChatMessage) => m.content as string).filter((t: string) => t.trim().length > 0);
              if (userTexts.length > 0) {
                inputHistoryRef.current[lastChatId] = userTexts.slice(-100);
                try { window.localStorage.setItem(STORAGE_INPUT_HISTORY, JSON.stringify(inputHistoryRef.current)); } catch { /* ignore */ }
              }
            }
          }
        }).catch(() => { /* ignore */ });
      }
    }).catch(() => { /* ignore */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ── Session resume effect ── */
  useEffect(() => {
    const activeChatId = currentChatIdRef.current;
    if (!activeChatId) return;
    if (loadedChatIdForResume !== activeChatId) return;
    if (sessionResumedChatIdRef.current === activeChatId) return;
    if (authStatus === 'loading') return;
    sessionResumedChatIdRef.current = activeChatId;
    needsContextRestoreRef.current = true;
    const sessions = currentAgentSessionsRef.current;
    const entries = Object.entries(sessions)
      .map(([agentId, raw]) => [agentId, lastSessionId(raw)] as [string, string | null])
      .filter(([, sid]) => !!sid) as [string, string][];
    if (entries.length === 0) return;
    void (async () => {
      try {
        const results = await Promise.allSettled(
          entries.map(([agentId, sessionId]) => acp({ action: 'resume-session', agentId, sessionId, chatId: activeChatId })),
        );
        const allLoaded = results.every(r => r.status === 'fulfilled' && (r as any).value?.loaded === true);
        if (allLoaded) needsContextRestoreRef.current = false;
        for (const [index, r] of results.entries()) {
          if (r.status !== 'fulfilled') continue;
          const agentId = entries[index]?.[0];
          const val = (r as any).value;
          if (agentId && val?.sessionId) {
            currentAgentSessionsRef.current = { ...currentAgentSessionsRef.current, [agentId]: val.sessionId };
          }
          if (agentId && val?.activeTurn && !val.activeTurn.done) {
            acpHandlers.resumeActiveTurn(agentId, val.activeTurn);
          }
          if (val?.recoveredMessages?.length > 0) {
            for (const rm of val.recoveredMessages) addMessage({ type: 'agent', content: rm.content, agentId: rm.agentId, ts: rm.ts });
            addMessage({ type: 'system', content: `✅ Recovered ${val.recoveredMessages.length} message(s) from previous session.` });
          }
        }
      } catch { /* ignore */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedChatIdForResume, authStatus]);

  /* ── Test window hook ── */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'test' && process.env.NEXT_PUBLIC_E2E_TESTS !== '1') return;
    const testWindow = window as typeof window & {
      __TEST_dispatchToAgent?: (typeof acpHandlers)['dispatchToAgent'];
      __TEST_getCurrentChatId?: () => string;
    };
    testWindow.__TEST_dispatchToAgent = acpHandlers.dispatchToAgent;
    testWindow.__TEST_getCurrentChatId = () => currentChatIdRef.current;
    return () => {
      delete testWindow.__TEST_dispatchToAgent;
      delete testWindow.__TEST_getCurrentChatId;
    };
  });

  const getChatSidebarStatus = useCallback((chatId: string): { label: string; kind: 'running' | 'done' | 'error' } | null => {
    const hasActiveRun = acpHandlers.isChatRunning(chatId);
    const chatMessages = chatMessagesRef.current[chatId] || (chatId === currentChatIdRef.current ? messagesRef.current : []);
    const pendingAgent = [...chatMessages].reverse().find(m => m.type === 'agent' && m.pending);
    if (hasActiveRun || pendingAgent) return { label: pendingAgent?.statusText || 'Running', kind: 'running' };
    if ([...chatMessages].reverse().some(m => m.type === 'user' && m.sendStatus === 'failed')) return { label: 'Error', kind: 'error' };
    const lastAgent = [...chatMessages].reverse().find(m => m.type === 'agent');
    if (!lastAgent) return null;
    if (getMessageCopyText(lastAgent).trim().startsWith('⚠️')) return { label: 'Error', kind: 'error' };
    return { label: 'Done', kind: 'done' };
  }, [currentChatId, messages, runVersion]);

  return {
    /* state */
    messages, chatHistory, currentChatId, activeSidebarChatId, chatName, chatCounter,
    runVersion, shareDialog, expandedMessages, loadedChatIdForResume,
    orchestrationMode,
    pendingWorkflowPlan,
    /* state setters exposed for page.tsx */
    setChatHistory, setChatName, setCurrentChatId, setActiveSidebarChatId,
    setShareDialog, setExpandedMessages, setOrchestrationMode,
    setPendingWorkflowPlan,
    dismissedFollowUpOrchId, setDismissedFollowUpOrchId,
    /* refs */
    messagesRef, chatMessagesRef, currentChatIdRef, chatNameRef, sessionRunsRef,
    orchestrationsRef, currentAgentSessionsRef, needsContextRestoreRef,
    inputHistoryRef, fileCommentCallbacksRef, panelCallbacksRef,
    /* core message functions */
    setMessagesForChat, addMessage, updateMessage, removeMessage, notifyRunStateChanged,
    /* failed send */
    markUserMessageSendFailed, clearUserMessageSendFailure,
    /* acp handlers */
    isChatRunning: acpHandlers.isChatRunning,
    getChatSidebarStatus,
    dispatchToAgent: acpHandlers.dispatchToAgent,
    resumeActiveTurn: acpHandlers.resumeActiveTurn,
    /* orchestration handlers */
    dispatchParsedPrompt: orchHandlers.dispatchParsedPrompt,
    maybeAdvanceOrchestration: orchHandlers.maybeAdvanceOrchestration,
    /* persistence handlers */
    ...persistHandlers,
    /* send/stop/answer */
    handleSend, handleStop, retryFailedSend, resendFailedUserMessage,
    sendWorkflowFollowUpReply,
    answerAgentUserRequest, dismissAgentUserRequest,
  };
}
