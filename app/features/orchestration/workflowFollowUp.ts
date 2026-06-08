import type { OrchestrationState } from '../chat/chatTypes';

export type WorkflowFollowUp = {
  orchestrationId: string;
  awaitingAgentIds: string[];
  awaitingNodeIds: string[];
};

function looksLikeQuestion(text: string): boolean {
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
 * Look at the most recent workflow orchestration in the given chat and figure
 * out which nodes (and thus agents) appear to still be expecting a follow-up
 * reply from the user. We heuristically detect this by checking whether the
 * node's final output text reads as a question.
 */
export function detectWorkflowFollowUp(
  orchestrations: Record<string, OrchestrationState>,
  chatId: string | null | undefined,
): WorkflowFollowUp | null {
  if (!chatId) return null;
  const all = Object.values(orchestrations).filter((o) => {
    if (o.mode !== 'workflow' || !o.workflowPlan) return false;
    if (o.sourceChatId && o.sourceChatId !== chatId) return false;
    return true;
  });
  if (all.length === 0) return null;
  // Pick the most recently created (insertion order).
  const latest = all[all.length - 1];
  const statuses = latest.nodeStatuses || {};
  const awaitingNodeIds: string[] = [];
  const awaitingAgentIds: string[] = [];
  for (const node of latest.workflowPlan!.nodes) {
    const s = statuses[node.id];
    if (s !== 'ok') continue; // only finished-OK nodes can be "awaiting follow-up"
    const text = latest.results[node.id] || latest.results[node.agent] || '';
    if (!looksLikeQuestion(text)) continue;
    awaitingNodeIds.push(node.id);
    if (!awaitingAgentIds.includes(node.agent)) awaitingAgentIds.push(node.agent);
  }
  if (awaitingAgentIds.length === 0) return null;
  return { orchestrationId: latest.id, awaitingAgentIds, awaitingNodeIds };
}
