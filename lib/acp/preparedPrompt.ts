import { readTransfer } from '../chatTransferStore';
import { ChatSyncError, isRecord } from '../chatSyncProtocol';

export function resolvePreparedPrompt(userId: string, reference: Record<string, unknown>): Record<string, unknown> {
  if (typeof reference.payloadRef !== 'string' || typeof reference.chatId !== 'string') {
    throw new ChatSyncError('invalid_prompt_reference', 400);
  }
  const payload = readTransfer(userId, reference.payloadRef, reference.chatId, 'acp');
  if (!isRecord(payload) || payload.action !== 'send' || payload.agentId !== reference.agentId
    || payload.chatId !== reference.chatId || payload.payloadRef !== undefined) {
    throw new ChatSyncError('invalid_prompt_reference', 400);
  }
  return payload;
}
