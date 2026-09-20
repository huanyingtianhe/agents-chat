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
  if (!crypto.subtle) throw new Error('Large message uploads require HTTPS or localhost for checksum verification.');
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data).buffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function newOperationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
