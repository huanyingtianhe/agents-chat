import type { ChatMessage, OrchestrationState } from '../chat/chatTypes';

export type WorkflowFollowUp = {
  /** Stable id used to dismiss this follow-up. For workflow nodes this is the
   *  orchestration id; for a single-agent reply it's the message id. */
  orchestrationId: string;
  awaitingAgentIds: string[];
  awaitingNodeIds: string[];
};

export function looksLikeQuestion(text: string): boolean {
  if (!text) return false;
  const stripped = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .trimEnd();
  if (!stripped) return false;
  const lastChar = stripped.slice(-1);
  if (lastChar === '?' || lastChar === '？') return true;
  // Common request phrasings even without trailing '?'
  const tail = stripped.slice(-300).toLowerCase();
  return /\b(could you clarify|please (?:clarify|specify|confirm|let me know|provide)|which (?:branch|file|option|one)|would you like|do you want|shall i)\b/.test(tail);
}

/**
 * Decide whether the chat is "awaiting a follow-up reply" from the user.
 *
 * Priority:
 *   1. Most recent workflow orchestration in this chat with at least one
 *      node that finished OK with a question-like output.
 *   2. Otherwise, fall back to the last completed assistant message in this
 *      chat: if it has an agentId and reads like a question, treat that
 *      agent as awaiting a reply.
 */
export function detectWorkflowFollowUp(
  orchestrations: Record<string, OrchestrationState>,
  chatId: string | null | undefined,
  messages?: ChatMessage[],
): WorkflowFollowUp | null {
  if (!chatId) return null;

  // 1) Workflow-orchestration nodes.
  const all = Object.values(orchestrations).filter((o) => {
    if (o.mode !== 'workflow' || !o.workflowPlan) return false;
    if (o.sourceChatId && o.sourceChatId !== chatId) return false;
    return true;
  });
  if (all.length > 0) {
    const latest = all[all.length - 1];
    const statuses = latest.nodeStatuses || {};
    const awaitingNodeIds: string[] = [];
    const awaitingAgentIds: string[] = [];
    for (const node of latest.workflowPlan!.nodes) {
      const s = statuses[node.id];
      if (s !== 'ok') continue;
      const text = latest.results[node.id] || latest.results[node.agent] || '';
      if (!looksLikeQuestion(text)) continue;
      awaitingNodeIds.push(node.id);
      if (!awaitingAgentIds.includes(node.agent)) awaitingAgentIds.push(node.agent);
    }
    if (awaitingAgentIds.length > 0) {
      return { orchestrationId: latest.id, awaitingAgentIds, awaitingNodeIds };
    }
  }

  // 2) Message-list fallback: the last completed assistant message in this
  //    chat reads as a question. This handles the common case where the
  //    in-memory orchestration state was lost (page reload / hot reload)
  //    but the chat history still has the agent's question.
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type === 'user') return null; // user already replied
      if (m.type !== 'agent') continue;
      if (m.pending) return null;          // still streaming
      if (m.summary) continue;             // skip summary blocks
      if (!m.agentId) continue;
      const text = m.content || '';
      if (!looksLikeQuestion(text)) return null;
      return {
        orchestrationId: `msg-${m.id}`,
        awaitingAgentIds: [m.agentId],
        awaitingNodeIds: [],
      };
    }
  }

  return null;
}
