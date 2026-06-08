import type { MutableRefObject } from 'react';
import type { ChatAttachment } from '../../composer/attachmentTypes';
import { getAttachmentSummaryText } from '../../composer/attachmentHelpers';
import type { Agent } from '../../agents/agentTypes';
import type { ChatMessage, DispatchToAgentOptions, OrchestrationMode, OrchestrationState, SessionRunContext } from '../chatTypes';
import { PromptSendFailedError } from './chatRunLoop';
import { SCHEDULER_AGENT_ID } from '../chatHelpers';
import { renderInstruction } from '@/lib/workflow/templating.mjs';
import { buildPlanPrompt, parseSchedulerPlanResponse } from '@/lib/workflow/scheduler.mjs';
import type { WorkflowPlan, NodeStatus } from '@/lib/workflow/workflowTypes.mjs';

export type OrchestrationContext = {
  acp: (body: Record<string, unknown>) => Promise<any>;
  orchestrationsRef: MutableRefObject<Record<string, OrchestrationState>>;
  sessionRunsRef: MutableRefObject<Record<string, SessionRunContext>>;
  agentsRef: MutableRefObject<Agent[]>;
  orchestrationModeRef: MutableRefObject<OrchestrationMode>;
  currentChatIdRef: MutableRefObject<string>;
  dispatchToAgent: (agentId: string, content: string, orchestrationId: string, kind: 'worker' | 'summary', options?: DispatchToAgentOptions) => Promise<string>;
  markUserMessageSendFailed: (chatId: string, userMessageId: string, error: string, resendAgentIds: string[], resendMessage: string, resendAttachments?: ChatAttachment[]) => void;
  addMessage: (msg: any, chatId?: string) => string;
  removeMessage: (id: string, chatId?: string) => void;
  notifyRunStateChanged: () => void;
};

export function createOrchestrationHandlers(ctx: OrchestrationContext) {
  function markOrchestrationPromptSendFailed(orchestrationId: string, err: unknown) {
    if (!(err instanceof PromptSendFailedError)) return false;
    const state = ctx.orchestrationsRef.current[orchestrationId];
    if (!state?.sourceChatId || !state.sourceUserMessageId) return false;
    ctx.markUserMessageSendFailed(
      state.sourceChatId, state.sourceUserMessageId, err.message,
      state.sourceAgentIds?.length ? state.sourceAgentIds : state.agentIds,
      state.sourceMessage || state.originalTask, state.sourceAttachments,
    );
    delete ctx.orchestrationsRef.current[orchestrationId];
    return true;
  }

  async function dispatchOrchestrationStep(
    orchestrationId: string,
    agentId: string,
    prompt: string,
    kind: 'worker' | 'summary',
    options?: DispatchToAgentOptions,
  ) {
    try {
      await ctx.dispatchToAgent(agentId, prompt, orchestrationId, kind, options);
      return true;
    } catch (err) {
      if (markOrchestrationPromptSendFailed(orchestrationId, err)) return false;
      throw err;
    }
  }

  async function cleanupDispatchedRuns(runKeys: string[]) {
    await Promise.all(runKeys.map(async (runKey) => {
      const run = ctx.sessionRunsRef.current[runKey];
      if (!run) return;
      try { await ctx.acp({ action: 'interrupt', agentId: run.agentId, chatId: run.chatId }); } catch { /* ignore */ }
      ctx.removeMessage(run.pendingId, run.chatId);
      delete ctx.sessionRunsRef.current[runKey];
    }));
    ctx.notifyRunStateChanged();
  }

  async function maybeAdvanceOrchestration(orchestrationId: string) {
    const state = ctx.orchestrationsRef.current[orchestrationId];
    if (!state || state.summaryStarted) return;
    const orchestrationChatId = state.sourceChatId || ctx.currentChatIdRef.current;

    if (state.mode === 'workflow' && state.workflowPlan) {
      const plan = state.workflowPlan;
      const statuses = state.nodeStatuses ?? (state.nodeStatuses = {});
      const nodeById = new Map(plan.nodes.map((n) => [n.id, n]));

      // Cascade skip on failed/skipped deps.
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of plan.nodes) {
          const cur = statuses[n.id];
          if (cur && cur !== 'pending') continue;
          for (const d of n.dependsOn) {
            const ds = statuses[d];
            if (ds === 'failed' || ds === 'skipped') {
              statuses[n.id] = 'skipped';
              changed = true;
              break;
            }
          }
        }
      }
      ctx.notifyRunStateChanged();

      // Dispatch every ready (pending) node whose deps are all ok.
      const ready = plan.nodes.filter((n) => {
        const s = statuses[n.id];
        if (s && s !== 'pending') return false;
        return n.dependsOn.every((d) => statuses[d] === 'ok');
      });
      for (const n of ready) {
        statuses[n.id] = 'running';
        const upstream: Record<string, string> = {};
        for (const d of n.dependsOn) upstream[d] = state.results[d] || '';
        const prompt = renderInstruction(n.instruction, state.originalTask, upstream, n.dependsOn);
        void dispatchOrchestrationStep(orchestrationId, n.agent, prompt, 'worker', {
          chatId: orchestrationChatId, relation: `Workflow node ${n.id}`, workflowNodeId: n.id,
        });
      }
      ctx.notifyRunStateChanged();

      // Done? All nodes terminal AND no running runs left.
      const allTerminal = plan.nodes.every((n) => {
        const s = statuses[n.id];
        return s === 'ok' || s === 'failed' || s === 'skipped';
      });
      if (allTerminal) {
        state.summaryStarted = true;
        ctx.notifyRunStateChanged();
      }
      return;
    }

    if (state.mode === 'pipeline') {
      if (state.nextIndex < state.agentIds.length) {
        const prevId = state.agentIds[state.nextIndex - 1];
        const nextId = state.agentIds[state.nextIndex];
        const context = state.agentIds.slice(0, state.nextIndex)
          .map((id) => `## ${id}\n${state.results[id] || '(no result)'}`).join('\n\n');
        const prompt = [
          'You are participating in a multi-agent pipeline task.',
          `Original task: ${state.originalTask}`,
          prevId ? 'Please continue based on the previous agent output.' : 'Please provide your initial result.',
          context ? `\nExisting context:\n${context}` : '',
        ].filter(Boolean).join('\n');
        state.nextIndex += 1;
        await dispatchOrchestrationStep(orchestrationId, nextId, prompt, 'worker', {
          chatId: orchestrationChatId, round: state.nextIndex + 1,
          relation: prevId ? `Based on ${prevId}'s output` : 'Pipeline initial step',
        });
        return;
      }
      state.summaryStarted = true;
      const summaryPrompt = [
        'You are the final coordinator. Please summarize the results of this serial multi-agent pipeline.',
        `Original task: ${state.originalTask}`, '',
        ...state.agentIds.map((id) => `## ${id}\n${state.results[id] || '(no result)'}`), '',
        'Please output the final conclusion and next steps.',
      ].join('\n');
      const summaryAgent = state.agentIds[0] || 'main';
      await dispatchOrchestrationStep(orchestrationId, summaryAgent, summaryPrompt, 'summary', { chatId: orchestrationChatId, relation: 'Final conclusion', summary: true });
    }

    if (state.mode === 'auto') {
      const ext = state as Record<string, unknown>;
      const phase = ext.autoPhase as string;
      console.log('[Auto] maybeAdvance called, phase:', phase, 'results:', Object.keys(state.results));
      if (phase !== 'awaiting-plan') return;
      const lastResult = Object.values(state.results).pop() || '';
      const parsed = parseSchedulerPlanResponse(lastResult);
      if (!parsed.ok) {
        console.warn('[Auto] plan parse failed:', parsed.error, '\nRaw:', lastResult.slice(0, 500));
        state.summaryStarted = true;
        ctx.addMessage({
          type: 'system',
          content: `⚠️ Auto mode: scheduler did not return a valid workflow plan (${parsed.error}). Please try again or use Workflow mode directly.`,
        }, orchestrationChatId);
        ctx.notifyRunStateChanged();
        return;
      }
      const allowed = new Set(state.agentIds);
      const bad = parsed.plan.nodes.find((n: { agent: string }) => !allowed.has(n.agent));
      if (bad) {
        state.summaryStarted = true;
        ctx.addMessage({
          type: 'system',
          content: `⚠️ Auto mode: scheduler referenced unknown agent "${bad.agent}". Allowed: ${[...allowed].join(', ')}.`,
        }, orchestrationChatId);
        ctx.notifyRunStateChanged();
        return;
      }
      // Transition to workflow mode and execute via the DAG engine.
      const plan = parsed.plan;
      const statuses: Record<string, NodeStatus> = {};
      for (const n of plan.nodes) statuses[n.id] = 'pending';
      state.mode = 'workflow';
      state.workflowPlan = plan;
      state.nodeStatuses = statuses;
      state.results = {};
      ctx.notifyRunStateChanged();
      await maybeAdvanceOrchestration(orchestrationId);
      return;
    }
  }

  async function runAutoOrchestration(orchestrationId: string, agentIds: string[], task: string, originalText: string, chatId: string, promptAttachments: ChatAttachment[] = []) {
    const schedulerAgentId = SCHEDULER_AGENT_ID;
    const agentDescriptors = agentIds.map((id) => {
      const a = ctx.agentsRef.current.find((x) => x.id === id);
      return { id, description: a?.name || id };
    });
    const attachmentNote = promptAttachments.length ? `\n\n${getAttachmentSummaryText(promptAttachments)}` : '';
    const userMessage = `${originalText}${attachmentNote}\n\n(Cleaned task: ${task})`;
    const planPrompt = [
      buildPlanPrompt({ userMessage, agents: agentDescriptors }),
      '',
      'IMPORTANT: DO NOT use any tools. DO NOT read files. DO NOT run commands. DO NOT explore the codebase.',
      'Just analyze the user request and return the JSON plan.',
      'Respect explicit agent mentions, role assignments, and ordering in the original user message.',
      'If the user assigns separate agents to test/review vs code/fix, keep those as separate nodes.',
    ].join('\n');
    await ctx.dispatchToAgent(schedulerAgentId, planPrompt, orchestrationId, 'worker', {
      chatId, round: 0, relation: 'Auto: planning workflow',
    });
    const state = ctx.orchestrationsRef.current[orchestrationId];
    if (state) {
      (state as Record<string, unknown>).autoPhase = 'awaiting-plan';
      (state as Record<string, unknown>).promptAttachments = promptAttachments;
    }
  }

  async function dispatchParsedPrompt(
    agentIds: string[],
    message: string,
    originalText: string,
    orchestrationId: string,
    options?: { chatId?: string; relation?: string; sourceUserMessageId?: string; attachments?: ChatAttachment[] },
  ) {
    const useOrchestration = agentIds.length > 1;
    const effectiveMessage = message || originalText;
    const effectiveChatId = options?.chatId || ctx.currentChatIdRef.current;
    const promptAttachments = options?.attachments || [];
    const dispatchOptions = { chatId: effectiveChatId, relation: options?.relation, attachments: promptAttachments };
    const orchestrationMode = ctx.orchestrationModeRef.current;

    if (useOrchestration) {
      ctx.orchestrationsRef.current[orchestrationId] = {
        id: orchestrationId,
        mode: orchestrationMode,
        agentIds,
        originalTask: effectiveMessage,
        results: {},
        nextIndex: orchestrationMode === 'pipeline' ? 1 : 0,
        summaryStarted: false,
        round: 0,
        maxRounds: 1,
        sourceUserMessageId: options?.sourceUserMessageId,
        sourceChatId: effectiveChatId,
        sourceAgentIds: agentIds,
        sourceMessage: effectiveMessage,
        sourceAttachments: promptAttachments,
      };
    }
    try {
      if (!useOrchestration) {
        await ctx.dispatchToAgent(agentIds[0], effectiveMessage, orchestrationId, 'worker', dispatchOptions);
        return;
      }
      if (orchestrationMode === 'auto') {
        await runAutoOrchestration(orchestrationId, agentIds, effectiveMessage, originalText, effectiveChatId, promptAttachments);
      } else {
        await ctx.dispatchToAgent(agentIds[0], effectiveMessage, orchestrationId, 'worker', {
          ...dispatchOptions, round: 1, relation: dispatchOptions?.relation || 'Pipeline initial step',
        });
      }
    } catch (err) {
      if (useOrchestration) delete ctx.orchestrationsRef.current[orchestrationId];
      throw err;
    }
  }

  async function runWorkflowOrchestration(
    orchestrationId: string,
    plan: WorkflowPlan,
    userInput: string,
    chatId: string,
    options?: { sourceUserMessageId?: string; attachments?: ChatAttachment[] },
  ) {
    const agentIds = Array.from(new Set(plan.nodes.map((n) => n.agent)));
    const statuses: Record<string, NodeStatus> = {};
    for (const n of plan.nodes) statuses[n.id] = 'pending';
    ctx.orchestrationsRef.current[orchestrationId] = {
      id: orchestrationId,
      mode: 'workflow',
      agentIds,
      originalTask: userInput,
      results: {},
      nextIndex: 0,
      summaryStarted: false,
      round: 0,
      maxRounds: 1,
      sourceUserMessageId: options?.sourceUserMessageId,
      sourceChatId: chatId,
      sourceAgentIds: agentIds,
      sourceMessage: userInput,
      sourceAttachments: options?.attachments || [],
      workflowPlan: plan,
      nodeStatuses: statuses,
      replanCount: 0,
    };
    ctx.notifyRunStateChanged();
    await maybeAdvanceOrchestration(orchestrationId);
  }

  return { markOrchestrationPromptSendFailed, dispatchOrchestrationStep, cleanupDispatchedRuns, maybeAdvanceOrchestration, runAutoOrchestration, runWorkflowOrchestration, dispatchParsedPrompt };
}
