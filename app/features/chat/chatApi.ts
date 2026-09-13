import type { Agent } from '../agents/agentTypes';
import { isAcpFailureResult } from './chatHelpers';

export type StorageUnavailableResult = {
  ok: false;
  error: 'storage_unavailable';
};

export class StorageUnavailableError extends Error {
  readonly code = 'storage_unavailable';

  constructor() {
    super('Stored chats and agent configuration are temporarily unavailable.');
    this.name = 'StorageUnavailableError';
  }
}

export function isStorageUnavailableResult(value: unknown): value is StorageUnavailableResult {
  return !!value
    && typeof value === 'object'
    && (value as { ok?: unknown }).ok === false
    && (value as { error?: unknown }).error === 'storage_unavailable';
}

export async function readJsonApiResponse<T = any>(res: Response): Promise<T> {
  const data = await res.json();
  if (res.status === 503 && isStorageUnavailableResult(data)) {
    throw new StorageUnavailableError();
  }
  return data as T;
}

export async function acpApi(body: Record<string, unknown>) {
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
  return readJsonApiResponse(res);
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
