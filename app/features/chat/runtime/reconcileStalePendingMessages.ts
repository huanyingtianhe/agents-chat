import type { ChatMessage } from '../chatTypes';

export type AgentResumeOutcome =
  | {
      agentId: string;
      status: 'fulfilled';
      activeTurn?: { done?: boolean } | null;
    }
  | {
      agentId: string;
      status: 'rejected';
    };

export type StalePendingReconciliation = {
  messages: ChatMessage[];
  changed: boolean;
};

type ResumeSessionResult = {
  ok?: boolean;
  activeTurn?: { done?: boolean } | null;
};

export function toAgentResumeOutcome(
  agentId: string,
  result: PromiseSettledResult<ResumeSessionResult>,
): AgentResumeOutcome {
  if (result.status === 'rejected' || result.value.ok !== true) {
    return { agentId, status: 'rejected' };
  }
  return {
    agentId,
    status: 'fulfilled',
    activeTurn: result.value.activeTurn ?? null,
  };
}

export function collectInterruptedAgentIds(
  outcomes: AgentResumeOutcome[],
): Set<string> {
  return new Set(
    outcomes
      .filter((outcome): outcome is Extract<AgentResumeOutcome, { status: 'fulfilled' }> =>
        outcome.status === 'fulfilled'
        && (!outcome.activeTurn || outcome.activeTurn.done === true))
      .map((outcome) => outcome.agentId),
  );
}

export function reconcileStalePendingMessages(
  messages: ChatMessage[],
  interruptedAgentIds: ReadonlySet<string>,
): StalePendingReconciliation {
  let changed = false;
  const reconciled = messages.map((message) => {
    if (
      message.type !== 'agent'
      || !message.pending
      || !message.agentId
      || !interruptedAgentIds.has(message.agentId)
    ) {
      return message;
    }

    changed = true;
    return {
      ...message,
      content: message.content.trim() ? message.content : '⏹ Interrupted',
      pending: false,
      statusText: 'Interrupted',
      ptyPhase: undefined,
      userRequest: undefined,
    };
  });

  return {
    messages: changed ? reconciled : messages,
    changed,
  };
}
