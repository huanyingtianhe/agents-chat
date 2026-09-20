import type { Agent } from '../agents/agentTypes';
import { isAcpFailureResult } from './chatHelpers';
import { requestJson, uploadJson } from './runtime/chatTransferClient';

export async function acpApi(body: Record<string, unknown>) {
  if (body.action === 'send' && new TextEncoder().encode(JSON.stringify(body)).length > 512 * 1024) {
    if (typeof body.chatId !== 'string' || !body.chatId) throw new Error('A saved chat is required for a large prompt.');
    const id = crypto.randomUUID();
    const userId = typeof body.userId === 'string' ? body.userId : undefined;
    await uploadJson(body, body.chatId, 'acp', id, fetch, userId);
    const result = await requestJson('/api/acp', {
      action: 'send', agentId: body.agentId, chatId: body.chatId, payloadRef: id, userId,
    });
    void requestJson('/api/chat-transfers', { action: 'delete', id, userId })
      .catch(error => console.error('Failed to clean up a completed prompt upload', error));
    return result;
  }
  const res = await fetch('/api/acp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    // Session expired — redirect to login
    window.location.href = '/login';
    return { ok: false, error: 'Session expired. Please sign in again.' };
  }
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return { ok: false, error: `Unexpected response (${res.status}). Please refresh or sign in again.` };
  }
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
