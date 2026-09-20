export const TRANSFER_CHUNK_BYTES = 256 * 1024;
export const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
export const CHAT_REQUEST_TIMEOUT_MS = 30_000;

export class ChatSyncError extends Error {
  constructor(public code: string, public status = 409) {
    super(code);
    this.name = 'ChatSyncError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
