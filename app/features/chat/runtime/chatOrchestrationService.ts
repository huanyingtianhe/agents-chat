import type { MutableRefObject } from 'react';
import type { ChatAttachment } from '../../composer/attachmentTypes';
import { getAttachmentSummaryText } from '../../composer/attachmentHelpers';
import type { Agent } from '../../agents/agentTypes';
import type { ChatMessage, DispatchToAgentOptions, OrchestrationMode, OrchestrationState, SessionRunContext } from '../chatTypes';
import { PromptSendFailedError, AUTO_MAX_STEPS } from './chatRunLoop';
import { SCHEDULER_AGENT_ID } from '../chatHelpers';

export type OrchestrationContext = {
  acp: (body: Record<string, unknown>) => Promise<any>;
  orchestrationsRef: MutableRefObject<Record<string, OrchestrationState>>;
  sessionRunsRef: MutableRefObject<Record<string, SessionRunContext>>;
  agentsRef: MutableRefObject<Agent[]>;
  orchestrationModeRef: MutableRefObject<OrchestrationMode>;
  discussionRoundsRef: MutableRefObject<number>;
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

    if (state.mode === 'discussion') {
      const allDone = state.agentIds.every((id) => typeof state.results[id] === 'string');
      if (!allDone) return;
      if (state.round < state.maxRounds) {
        const prev = { ...state.results };
        state.results = {};
        state.round += 1;
        await Promise.all(state.agentIds.map((id) => {
          const others = state.agentIds.filter((x) => x !== id)
            .map((x) => `## ${x}'s perspective\n${prev[x] || '(no result)'}`).join('\n\n');
          const prompt = [
            `You are in round ${state.round} of a multi-agent discussion.`,
            `Original task: ${state.originalTask}`, '',
            'Below are other agents\' perspectives from the previous round. Please respond:',
            '1. State which points you agree with and from whom',
            '2. State which points you disagree with or want to revise',
            '3. Provide your updated perspective for this round', '', others,
          ].join('\n');
          return dispatchOrchestrationStep(orchestrationId, id, prompt, 'worker', {
            chatId: orchestrationChatId, round: state.round, relation: `Responding to round ${state.round - 1} perspectives`,
          });
        }));
        return;
      }
      state.summaryStarted = true;
      const summaryPrompt = [
        'You are the final coordinator. Please summarize the conclusions from this multi-agent discussion.',
        `Original task: ${state.originalTask}`, `Total rounds: ${state.maxRounds}`, '',
        ...state.agentIds.map((id) => `## ${id}\n${state.results[id] || '(no result)'}`), '',
        'Please output:', '1. Consensus reached', '2. Remaining disagreements', '3. Final recommended plan',
      ].join('\n');
      const summaryAgent = state.agentIds[0] || 'main';
      await dispatchOrchestrationStep(orchestrationId, summaryAgent, summaryPrompt, 'summary', { chatId: orchestrationChatId, relation: 'Final conclusion', summary: true });
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
      const autoStep = (ext.autoStep as number) || 0;
      const schedulerAgentId = SCHEDULER_AGENT_ID;
      const agentList = (ext.autoAgentList as string) || '';
      const autoOriginalText = (ext.autoOriginalText as string) || state.originalTask;
      const autoHistory = (ext.autoHistory as { agent: string; instruction: string; step: number }[]) || [];
      const promptAttachments = (ext.promptAttachments as ChatAttachment[]) || [];
      const dispatchedAttachmentAgents = (ext.dispatchedAttachmentAgents as string[]) || [];
      const dispatchedAttachmentAgentSet = new Set(dispatchedAttachmentAgents);
      const prepareNextDispatch = async (agentId: string) => {
        await ctx.acp({ action: 'turn-clear', agentId, chatId: orchestrationChatId }).catch(() => null);
        await new Promise((r) => setTimeout(r, 800));
      };
      try {
        if (phase === 'awaiting-plan' || phase === 'awaiting-eval') {
          const lastResult = Object.values(state.results).pop() || '';
          let decision: { done?: boolean; nextAgent?: string; instruction?: string; summary?: string } = { done: true };
          try {
            const jsonMatch = lastResult.match(/\{[\s\S]*\}/);
            if (jsonMatch) decision = JSON.parse(jsonMatch[0]);
          } catch (e) {
            console.warn('[Auto] Failed to parse scheduler JSON:', e, '\nRaw:', lastResult.slice(0, 500));
          }
          console.log('[Auto]', phase, 'decision:', JSON.stringify(decision), 'results keys:', Object.keys(state.results));
          if (decision.done || !decision.nextAgent || autoStep >= AUTO_MAX_STEPS) {
            ext.autoPhase = 'done';
            state.summaryStarted = true;
            const summaryPrompt = [
              'You are the final coordinator. Summarize the results of this auto-scheduled multi-agent task.',
              `Original task: ${state.originalTask}`, '',
              ...autoHistory.map((h, i) => `## Step ${i + 1} — ${h.agent}\n${state.results[h.agent] || '(no result)'}`), '',
              decision.summary ? `\nScheduler conclusion: ${decision.summary}` : '',
              '\nPlease output:', '1. What was accomplished', '2. Final result', '3. Any remaining issues or next steps',
            ].join('\n');
            await prepareNextDispatch(schedulerAgentId);
            await dispatchOrchestrationStep(orchestrationId, schedulerAgentId, summaryPrompt, 'summary', { chatId: orchestrationChatId, relation: 'Auto: final summary', summary: true });
            return;
          }
          ext.autoStep = autoStep + 1;
          ext.autoPhase = 'awaiting-execution';
          ext.autoCurrentTarget = decision.nextAgent;
          autoHistory.push({ agent: decision.nextAgent, instruction: decision.instruction || state.originalTask, step: autoStep + 1 });
          state.results = {};
          await prepareNextDispatch(decision.nextAgent);
          const workerAttachments = dispatchedAttachmentAgentSet.has(decision.nextAgent) ? [] : promptAttachments;
          dispatchedAttachmentAgentSet.add(decision.nextAgent);
          ext.dispatchedAttachmentAgents = Array.from(dispatchedAttachmentAgentSet);
          await dispatchOrchestrationStep(orchestrationId, decision.nextAgent, decision.instruction || state.originalTask, 'worker', {
            chatId: orchestrationChatId, round: autoStep + 1, relation: `Auto: step ${autoStep + 1}`, attachments: workerAttachments,
          });
          return;
        }
        if (phase === 'awaiting-execution') {
          const targetAgent = ext.autoCurrentTarget as string;
          const agentResult = state.results[targetAgent] || '(no response)';
          ext.autoPhase = 'awaiting-eval';
          state.results = {};
          const evalPrompt = [
            'You are a ROUTING-ONLY scheduler evaluating a step result. Your ONLY job is to decide next action and output JSON.',
            'DO NOT use any tools. DO NOT read files. DO NOT run commands. Just evaluate and decide.',
            'Respect explicit agent mentions, role assignments, and ordering in the original user message.',
            'If the user assigned separate agents to testing/review and coding/fixing, keep those responsibilities separate.',
            `\nOriginal task: ${state.originalTask}`,
            `\nOriginal user message with agent mentions: ${autoOriginalText}`,
            `\nAvailable agents:\n${agentList}`,
            `\nStep ${autoStep} — Agent "${targetAgent}" responded:\n${agentResult}`,
            autoHistory.length > 1 ? `\nPrior steps:\n${autoHistory.slice(0, -1).map((h) => `Step ${h.step} (${h.agent}): ${h.instruction}`).join('\n')}` : '',
            `\nSteps remaining: ${AUTO_MAX_STEPS - autoStep}`,
            '\nRespond with ONLY a raw JSON object — no markdown fences, no explanation, no tool calls:',
            'The nextAgent value must be one of the available mentioned agents above.',
            '- If done: { "done": true, "summary": "<brief conclusion>" }',
            '- If another agent should act: { "done": false, "nextAgent": "<agent-id>", "instruction": "<what to tell the next agent, include relevant context>" }',
          ].join('\n');
          await prepareNextDispatch(schedulerAgentId);
          await dispatchOrchestrationStep(orchestrationId, schedulerAgentId, evalPrompt, 'worker', {
            chatId: orchestrationChatId, round: autoStep, relation: 'Auto: scheduler evaluating',
          });
          return;
        }
      } catch (err) {
        if (markOrchestrationPromptSendFailed(orchestrationId, err)) return;
        console.error('[Auto] orchestration step failed:', err);
        ctx.addMessage({ type: 'system', content: `⚠️ Auto orchestration error: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  async function runAutoOrchestration(orchestrationId: string, agentIds: string[], task: string, originalText: string, chatId: string, promptAttachments: ChatAttachment[] = []) {
    const schedulerAgentId = SCHEDULER_AGENT_ID;
    const agentList = agentIds.map((id) => {
      const a = ctx.agentsRef.current.find((x) => x.id === id);
      return `- ${id}: ${a?.name || id}`;
    }).join('\n');
    const history: { agent: string; instruction: string; step: number }[] = [];
    const planPrompt = [
      'You are a ROUTING-ONLY scheduler. Your ONLY job is to pick which agent handles the task and output JSON.',
      'DO NOT use any tools. DO NOT read files. DO NOT run commands. DO NOT explore the codebase.',
      'Just read the task and decide which agent should handle the next step.',
      'Respect explicit agent mentions, role assignments, and ordering in the original user message.',
      'If the user assigns one agent to test/review/check and another to code/fix/implement, do not combine those responsibilities into one agent.',
      'For conditional workflows, choose the first required step now; after that agent responds, evaluate whether another mentioned agent should act next.',
      `\nAvailable agents:\n${agentList}`,
      `\nOriginal user message with agent mentions: ${originalText}`,
      `\nCleaned task text: ${task}`,
      promptAttachments.length ? `\n${getAttachmentSummaryText(promptAttachments)}` : '',
      '\nRespond with ONLY a raw JSON object — no markdown fences, no explanation, no tool calls:',
      'The nextAgent value must be one of the available mentioned agents above.',
      '{ "nextAgent": "<agent-id>", "instruction": "<detailed instruction for that agent>" }',
      'If no agent is needed: { "done": true, "summary": "<your answer>" }',
    ].join('\n');
    await ctx.dispatchToAgent(schedulerAgentId, planPrompt, orchestrationId, 'worker', {
      chatId, round: 0, relation: 'Auto: scheduler planning',
    });
    const state = ctx.orchestrationsRef.current[orchestrationId];
    if (state) {
      (state as Record<string, unknown>).autoHistory = history;
      (state as Record<string, unknown>).autoAgentList = agentList;
      (state as Record<string, unknown>).autoOriginalText = originalText;
      (state as Record<string, unknown>).promptAttachments = promptAttachments;
      (state as Record<string, unknown>).dispatchedAttachmentAgents = [];
      (state as Record<string, unknown>).autoStep = 0;
      (state as Record<string, unknown>).autoPhase = 'awaiting-plan';
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
    const discussionRounds = ctx.discussionRoundsRef.current;

    if (useOrchestration) {
      ctx.orchestrationsRef.current[orchestrationId] = {
        id: orchestrationId,
        mode: orchestrationMode,
        agentIds,
        originalTask: effectiveMessage,
        results: {},
        nextIndex: orchestrationMode === 'pipeline' ? 1 : 0,
        summaryStarted: false,
        round: orchestrationMode === 'discussion' ? 1 : 0,
        maxRounds: orchestrationMode === 'discussion' ? discussionRounds : 1,
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
      } else if (orchestrationMode === 'discussion') {
        const results = await Promise.allSettled(agentIds.map((id) => ctx.dispatchToAgent(id, effectiveMessage, orchestrationId, 'worker', {
          ...dispatchOptions, round: 1, relation: dispatchOptions?.relation || 'Round 1 independent perspective',
        })));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) {
          const startedRunKeys = results
            .filter((result): result is PromiseFulfilledResult<string> => result.status === 'fulfilled')
            .map((result) => result.value);
          await cleanupDispatchedRuns(startedRunKeys);
          throw failed.reason;
        }
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

  return { markOrchestrationPromptSendFailed, dispatchOrchestrationStep, cleanupDispatchedRuns, maybeAdvanceOrchestration, runAutoOrchestration, dispatchParsedPrompt };
}
