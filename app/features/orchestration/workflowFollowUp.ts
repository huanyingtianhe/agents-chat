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
  // Scan a longer tail and also accept a '?' anywhere near the end (covers
  // "…X? I can also do Y." style closers).
  const tail = stripped.slice(-600);
  if (/[?？]/.test(tail)) return true;
  const tailLower = tail.toLowerCase();
  return /\b(could you (?:clarify|confirm|tell me)|please (?:clarify|specify|confirm|let me know|provide|choose|pick|select)|which (?:branch|file|option|one|of)|would you (?:like|prefer)|do you (?:want|prefer|need)|shall i|should i|want me to|let me know|which (?:do|would) you|are you (?:sure|ok))\b/.test(tailLower);
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

  // 2) Message-list fallback: handles the case where the in-memory
  //    orchestration state was lost (page reload / hot reload) but the chat
  //    history still has the agent's question. To avoid spurious follow-ups
  //    on normal single-agent chats, only kick in when the last completed
  //    agent message was actually tagged as a workflow node.
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type === 'user') return null;
      if (m.type !== 'agent') continue;
      if (m.pending) return null;
      if (m.summary) continue;
      if (!m.agentId) continue;
      if (!m.relation || !m.relation.startsWith('Workflow node ')) return null;
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
