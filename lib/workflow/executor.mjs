import { renderInstruction } from './templating.mjs';

export async function runWorkflow(plan, userInput, dispatch, opts = {}) {
  const state = opts.initialState ?? {
    planId: opts.planId ?? `plan-${Date.now()}`,
    plan,
    nodeStatuses: Object.fromEntries(plan.nodes.map((n) => [n.id, 'pending'])),
    nodeOutputs: {},
  };
  const setStatus = (id, status, output, error) => {
    state.nodeStatuses[id] = status;
    if (output !== undefined) state.nodeOutputs[id] = output;
    if (opts.onStatusChange) opts.onStatusChange(id, status, output, error);
  };

  while (true) {
    // First, cascade skips for any pending node whose upstream is failed/skipped.
    for (const n of plan.nodes) {
      if (state.nodeStatuses[n.id] !== 'pending') continue;
      if (n.dependsOn.some((d) => state.nodeStatuses[d] === 'failed' || state.nodeStatuses[d] === 'skipped')) {
        setStatus(n.id, 'skipped');
      }
    }

    const ready = plan.nodes.filter((n) => {
      if (state.nodeStatuses[n.id] !== 'pending') return false;
      return n.dependsOn.every((d) => state.nodeStatuses[d] === 'ok');
    });

    if (ready.length === 0) {
      const stillActive = plan.nodes.some((n) =>
        state.nodeStatuses[n.id] === 'pending' || state.nodeStatuses[n.id] === 'running',
      );
      if (!stillActive) break;
      throw new Error('executor deadlock: no ready nodes but pending remain');
    }

    await Promise.all(
      ready.map(async (node) => {
        setStatus(node.id, 'running');
        try {
          const rendered = renderInstruction(
            node.instruction,
            userInput,
            state.nodeOutputs,
            node.dependsOn,
          );
          const output = await dispatch(node, rendered);
          setStatus(node.id, 'ok', output);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setStatus(node.id, 'failed', undefined, msg);
          state.failureReason = `node "${node.id}" failed: ${msg}`;
        }
      }),
    );
  }

  return state;
}
