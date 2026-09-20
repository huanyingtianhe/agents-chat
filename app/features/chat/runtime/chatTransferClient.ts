import { CHAT_REQUEST_TIMEOUT_MS, ChatSyncError, isRecord, MAX_TRANSFER_BYTES, sha256, TRANSFER_CHUNK_BYTES } from '@/lib/chatSyncProtocol';
import type { ChatCommitResult, ChatOperation } from '@/lib/chatSyncStore';

let pageLeaving = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { pageLeaving = true; });
  window.addEventListener('pageshow', () => { pageLeaving = false; });
}

export async function requestJson(
  url: string, body: unknown, request: typeof fetch = fetch,
  timeoutMs = CHAT_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  if (pageLeaving) throw new ChatSyncError('Page navigation interrupted the request. The draft will retry after reopening.', 408);
  const controller = new AbortController();
  const onPageHide = () => controller.abort();
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', onPageHide, { once: true });
    window.addEventListener('pagehide', onPageHide, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ChatSyncError('Request timed out. The server may have saved it; retry safely.', 408));
    }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await request(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const text = await response.text();
      let result: unknown;
      try { result = JSON.parse(text); }
      catch {
        throw new ChatSyncError(`Invalid server response (HTTP ${response.status}). Please retry.`, response.status);
      }
      if (!response.ok || !isRecord(result) || result.ok !== true) {
        const detail = isRecord(result) && typeof result.error === 'string' ? result.error : 'Request failed';
        throw new ChatSyncError(`${detail} (HTTP ${response.status})`, response.status);
      }
      return result;
    })()]);
  } finally {
    clearTimeout(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('beforeunload', onPageHide);
      window.removeEventListener('pagehide', onPageHide);
    }
  }
}

export async function uploadJson(
  value: unknown, chatId: string, purpose: 'chat' | 'acp', id: string, request: typeof fetch = fetch, userId?: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > MAX_TRANSFER_BYTES) throw new ChatSyncError('Message exceeds the 64 MiB upload limit. Split the message or attachments.', 413);
  const digest = await sha256(bytes);
  const total = Math.ceil(bytes.length / TRANSFER_CHUNK_BYTES);
  const status = await requestJson('/api/chat-transfers', { action: 'status', id, userId }, request);
  if (!Array.isArray(status.chunks) || !status.chunks.every(index => Number.isInteger(index))) {
    throw new Error('Invalid upload status response');
  }
  const received = new Set(status.chunks);
  for (let index = 0; index < total; index++) {
    if (received.has(index)) continue;
    const piece = bytes.subarray(index * TRANSFER_CHUNK_BYTES, (index + 1) * TRANSFER_CHUNK_BYTES);
    let binary = '';
    for (let offset = 0; offset < piece.length; offset += 8192) {
      binary += String.fromCharCode(...piece.subarray(offset, offset + 8192));
    }
    await requestJson('/api/chat-transfers', {
      id, chatId, purpose, index, total, bytes: bytes.length, digest, data: btoa(binary), userId,
    }, request);
  }
}

export async function commitOperation(operation: ChatOperation, request: typeof fetch = fetch): Promise<ChatCommitResult> {
  const direct = { action: 'save-sync', operation };
  let body: unknown = direct;
  if (new TextEncoder().encode(JSON.stringify(direct)).length > 512 * 1024) {
    await uploadJson(operation, operation.chat.id, 'chat', operation.operationId, request, operation.userId);
    body = { action: 'save-sync', transferId: operation.operationId, chatId: operation.chat.id };
  }
  const result = await requestJson('/api/chats', body, request);
  const versions = result.versions;
  if (!isRecord(versions) || !Object.values(versions).every(version => Number.isSafeInteger(version) && Number(version) >= 0)
    || operation.chat.messages.some(message => !Object.hasOwn(versions, message.id))) {
    throw new Error('Invalid chat commit acknowledgement');
  }
  if (body !== direct) {
    void requestJson('/api/chat-transfers', { action: 'delete', id: operation.operationId, userId: operation.userId }, request)
      .catch(error => console.error('Failed to clean up a completed chat upload', error));
  }
  return { ok: true, versions: result.versions as Record<string, number> };
}
