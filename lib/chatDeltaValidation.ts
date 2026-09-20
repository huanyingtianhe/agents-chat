import type { StoredChatDelta, StoredMessage } from './chatStore';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isMessage(value: unknown): value is StoredMessage {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id
    || (value.type !== 'user' && value.type !== 'agent' && value.type !== 'system')
    || typeof value.content !== 'string' || typeof value.ts !== 'number' || !Number.isFinite(value.ts)) return false;
  for (const key of ['agentId', 'relation', 'sendError', 'resendMessage', 'statusText', 'ptyPhase']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  for (const key of ['pending', 'summary']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return false;
  }
  if (value.round !== undefined && (typeof value.round !== 'number' || !Number.isFinite(value.round))) return false;
  if (value.sendStatus !== undefined && value.sendStatus !== 'failed') return false;
  if (value.parts !== undefined && !Array.isArray(value.parts)) return false;
  if (value.resendAgentIds !== undefined
    && (!Array.isArray(value.resendAgentIds) || !value.resendAgentIds.every(id => typeof id === 'string'))) return false;
  if (value.attachments !== undefined && (!Array.isArray(value.attachments) || !value.attachments.every(attachment =>
    isRecord(attachment)
    && ['id', 'name', 'mimeType', 'dataUrl'].every(key => typeof attachment[key] === 'string')
    && typeof attachment.size === 'number' && Number.isFinite(attachment.size) && attachment.size >= 0
    && (attachment.kind === 'image' || attachment.kind === 'file')))) return false;
  return true;
}

export function isStoredChatDelta(value: unknown): value is StoredChatDelta {
  return isRecord(value)
    && typeof value.id === 'string' && !!value.id
    && typeof value.name === 'string' && !!value.name
    && typeof value.ts === 'number' && Number.isFinite(value.ts)
    && (value.agentId === undefined || typeof value.agentId === 'string')
    && isRecord(value.agentSessions) && Object.values(value.agentSessions).every(session =>
      typeof session === 'string' || (Array.isArray(session) && session.every(id => typeof id === 'string')))
    && Array.isArray(value.messages) && value.messages.every(isMessage)
    && new Set(value.messages.map(message => message.id)).size === value.messages.length
    && (value.removedMessageIds === undefined || (Array.isArray(value.removedMessageIds)
      && value.removedMessageIds.every(id => typeof id === 'string' && !!id)));
}
