import type { Agent } from '../agents/agentTypes';
import { isAcpFailureResult } from './chatHelpers';

export async function acpApi(body: Record<string, unknown>) {
  const res = await fetch('/api/acp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

let localAgentsWarmupStarted = false;

export function warmLocalAgentsOnce(
  acpCall: (body: Record<string, unknown>) => Promise<unknown>,
  loadedAgents: Agent[],
) {
  if (localAgentsWarmupStarted) return;
  if (!loadedAgents.some(agent => !agent.relay)) return;

  localAgentsWarmupStarted = true;
  void acpCall({ action: 'warm-local-agents' })
    .then((result) => {
      if (isAcpFailureResult(result)) {
        console.error('Failed to warm local agents', result.error || result);
      }
    })
    .catch((err) => {
      console.error('Failed to warm local agents', err);
    });
}
