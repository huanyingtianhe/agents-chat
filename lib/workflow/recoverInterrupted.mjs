/**
 * Recovery for orchestrations hydrated after a page reload.
 *
 * Any node that was in 'running' when the tab died is converted to
 * 'awaiting-input' with a synthetic prompt so the inline follow-up card
 * reappears. The user can reply normally (retry) or type 'skip'.
 *
 * Also recomputes summaryStarted from current node statuses.
 *
 * Pure function: takes a state, returns a new state. No I/O.
 */

export const RELOAD_RECOVERY_PROMPT =
  '⚠️ This node was interrupted by a page reload. Reply to retry, or type "skip" to skip.';

const TERMINAL = new Set(['ok', 'failed', 'skipped', 'stopped']);

export function isTerminalStatus(status) {
  return TERMINAL.has(status);
}

/**
 * @param {object} state  OrchestrationState (mode 'workflow' expected)
 * @returns {object} a new state object; original is not mutated
 */
export function recoverInterruptedOrchestration(state) {
  if (!state || typeof state !== 'object') return state;

  const nodeStatuses = { ...(state.nodeStatuses || {}) };
  const results = { ...(state.results || {}) };
  let changed = false;

  for (const nodeId of Object.keys(nodeStatuses)) {
    if (nodeStatuses[nodeId] === 'running') {
      nodeStatuses[nodeId] = 'awaiting-input';
      if (!results[nodeId]) results[nodeId] = RELOAD_RECOVERY_PROMPT;
      changed = true;
    }
  }

  const planNodes = (state.workflowPlan && state.workflowPlan.nodes) || [];
  let summaryStarted = !!state.summaryStarted;
  if (planNodes.length > 0) {
    summaryStarted = planNodes.every((n) => isTerminalStatus(nodeStatuses[n.id]));
  }

  if (!changed && summaryStarted === !!state.summaryStarted) return state;

  return {
    ...state,
    nodeStatuses,
    results,
    summaryStarted,
  };
}
