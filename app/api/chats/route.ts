import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { listChats, getChat, mergeChat, saveChatDelta, deleteChat, renameChat, migrateFromJson, getLastChatId, setLastChatId, StoredChat, deleteOrchestrationsForChat, searchChats, updateChatGitContext } from '@/lib/chatStore';
import { isStoredChatDelta } from '@/lib/chatDeltaValidation';
import { commitChatOperation, isChatOperation } from '@/lib/chatSyncStore';
import { readTransfer } from '@/lib/chatTransferStore';
import { ChatSyncError } from '@/lib/chatSyncProtocol';
import { hasPersistedAgentSession } from '@/app/features/chat/chatHelpers';
import { getGitContextOptions, isValidStoredGitContext, validateGitContext } from '@/lib/gitContext';
import { getAgentById, getAllAgents, getUserChatLastUsedAgent, getUserLastUsedAgent, getUserSettings } from '@/lib/configStore';
import { createLogger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
const logger = createLogger('api.chats');

function getUserId(token: any): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  return token?.email || token?.name || token?.sub || 'anonymous';
}

function isAdminToken(token: any): boolean { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!token) return false;
  if (token.role === 'admin' || token.sub === 'admin') return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map((e: string) => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((token.email || '').toLowerCase());
}

const LAST_USED_AGENT_SCOPE_KEY = 'last_used_agent_scope';
const SCHEDULER_AGENT_ID = 'scheduler';

function getDefaultAgentCwd(): string | null {
  const agents = getAllAgents();
  const defaultAgent = agents.find((agent) => agent.id !== SCHEDULER_AGENT_ID && agent.cwd) || agents.find((agent) => agent.cwd);
  return defaultAgent?.cwd || null;
}

function resolveChatGitContextOptions(userId: string, chat: StoredChat) {
  const candidateRoots = new Set<string>();
  if (chat.gitContext?.repoRoot) candidateRoots.add(chat.gitContext.repoRoot);

  const settings = getUserSettings(userId);
  const lastUsedAgentScope = settings[LAST_USED_AGENT_SCOPE_KEY] === 'user' ? 'user' : 'chat';
  const rememberedAgentId = lastUsedAgentScope === 'chat'
    ? getUserChatLastUsedAgent(userId, chat.id)
    : getUserLastUsedAgent(userId);
  if (rememberedAgentId) {
    const rememberedAgent = getAgentById(rememberedAgentId);
    if (rememberedAgent?.cwd) candidateRoots.add(rememberedAgent.cwd);
  }

  if (chat.agentId) {
    const primaryAgent = getAgentById(chat.agentId);
    if (primaryAgent?.cwd) candidateRoots.add(primaryAgent.cwd);
  }
  const defaultAgentCwd = getDefaultAgentCwd();
  if (defaultAgentCwd) candidateRoots.add(defaultAgentCwd);

  logger.info({
    chatId: chat.id,
    hasSavedGitContext: !!chat.gitContext,
    savedRepoRoot: chat.gitContext?.repoRoot || null,
    primaryAgentId: chat.agentId || null,
    lastUsedAgentScope,
    rememberedAgentId: rememberedAgentId || null,
    candidateRoots: Array.from(candidateRoots),
    processCwd: process.cwd(),
  }, 'Resolving chat git context');

  for (const candidateRoot of candidateRoots) {
    const options = getGitContextOptions(chat.gitContext || null, candidateRoot);
    logger.info({
      chatId: chat.id,
      candidateRoot,
      available: options.available,
      repoRoot: options.repoRoot || null,
      effectiveWorktree: options.effective?.worktreePath || null,
      effectiveBranch: options.effective?.branchName || null,
      statusText: options.statusText || null,
    }, 'Tried git context candidate root');
    if (options.available) return options;
  }
  const fallbackOptions = getGitContextOptions(chat.gitContext || null);
  logger.warn({
    chatId: chat.id,
    available: fallbackOptions.available,
    repoRoot: fallbackOptions.repoRoot || null,
    effectiveWorktree: fallbackOptions.effective?.worktreePath || null,
    effectiveBranch: fallbackOptions.effective?.branchName || null,
    statusText: fallbackOptions.statusText || null,
    processCwd: process.cwd(),
  }, 'Fell back to process.cwd() for chat git context');
  return fallbackOptions;
}

export async function GET(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const userId = getUserId(token);
  const chatId = req.nextUrl.searchParams.get('id');

  if (chatId) {
    const chat = await getChat(userId, chatId);
    if (!chat) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    const gitContextOptions = resolveChatGitContextOptions(userId, chat);
    if (!chat.gitContext && gitContextOptions.effective) {
      logger.info({
        chatId,
        repoRoot: gitContextOptions.effective.repoRoot,
        worktreePath: gitContextOptions.effective.worktreePath,
        branchName: gitContextOptions.effective.branchName,
      }, 'Backfilling missing chat git context');
      chat.gitContext = gitContextOptions.effective;
      await updateChatGitContext(userId, chatId, gitContextOptions.effective);
    }
    return NextResponse.json({ ok: true, chat, gitContextOptions });
  }

  const searchQuery = req.nextUrl.searchParams.get('search');
  if (searchQuery && searchQuery.trim()) {
    const chats = await searchChats(userId, searchQuery.trim());
    return NextResponse.json({ ok: true, chats });
  }

  const chats = await listChats(userId);
  const lastChatId = await getLastChatId(userId);
  return NextResponse.json({ ok: true, chats, lastChatId });
}

export async function POST(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const userId = getUserId(token);
  const body = await req.json().catch(() => ({}));

  if (body?.action === 'save-sync') {
    try {
      const operation: unknown = typeof body.transferId === 'string' && typeof body.chatId === 'string'
        ? readTransfer(userId, body.transferId, body.chatId, 'chat') : body.operation;
      if (!isChatOperation(operation)) {
        return NextResponse.json({ ok: false, error: 'invalid_chat_operation' }, { status: 400 });
      }
      return NextResponse.json(commitChatOperation(userId, operation));
    } catch (error) {
      if (error instanceof ChatSyncError) return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
      logger.error({ err: error }, 'Failed to commit chat operation');
      return NextResponse.json({ ok: false, error: 'chat_save_failed' }, { status: 500 });
    }
  }

  if (body?.action === 'save-delta') {
    if (!isStoredChatDelta(body.chat)) {
      return NextResponse.json({ ok: false, error: 'invalid_chat_delta' }, { status: 400 });
    }
    try { await saveChatDelta(userId, body.chat); }
    catch (error) {
      if (error instanceof ChatSyncError) return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
      throw error;
    }
    return NextResponse.json({ ok: true });
  }

  // Admin-only: migrate JSON files to SQLite
  if (body?.action === 'migrate') {
    if (!isAdminToken(token)) return NextResponse.json({ ok: false, error: 'admin_only' }, { status: 403 });
    const result = await migrateFromJson();
    return NextResponse.json({ ok: true, migrated: result });
  }

  // Save last active chat ID (empty string clears the preference)
  if (body?.action === 'set-last-chat') {
    const chatId = body?.chatId;
    if (typeof chatId !== 'string') return NextResponse.json({ ok: false, error: 'missing_chatId' }, { status: 400 });
    await setLastChatId(userId, chatId);
    return NextResponse.json({ ok: true });
  }

  // Rename a chat
  if (body?.action === 'rename') {
    const chatId = body?.chatId;
    const newName = body?.name;
    if (typeof chatId !== 'string' || !chatId) return NextResponse.json({ ok: false, error: 'missing_chatId' }, { status: 400 });
    if (typeof newName !== 'string' || !newName.trim()) return NextResponse.json({ ok: false, error: 'missing_name' }, { status: 400 });
    await renameChat(userId, chatId, newName.trim());
    return NextResponse.json({ ok: true });
  }

  if (body?.action === 'update-git-context') {
    const chatId = body?.chatId;
    const gitContext = body?.gitContext;
    if (typeof chatId !== 'string' || !chatId) {
      return NextResponse.json({ ok: false, error: 'missing_chatId' }, { status: 400 });
    }
    if (!isValidStoredGitContext(gitContext)) {
      return NextResponse.json({ ok: false, error: 'invalid_git_context' }, { status: 400 });
    }
    const chat = await getChat(userId, chatId);
    if (!chat) {
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    if (hasPersistedAgentSession(chat.agentSessions)) {
      return NextResponse.json({ ok: false, error: 'git_context_locked' }, { status: 409 });
    }

    const options = getGitContextOptions(gitContext);
    const validated = validateGitContext(gitContext, options);
    if (!validated.ok) {
      return NextResponse.json({ ok: false, error: validated.error }, { status: 400 });
    }

    await updateChatGitContext(userId, chatId, validated.gitContext);
    return NextResponse.json({ ok: true, gitContext: validated.gitContext });
  }

  const chat = body?.chat as StoredChat | undefined;

  if (!chat?.id || !chat?.name || !Array.isArray(chat?.messages)) {
    return NextResponse.json({ ok: false, error: 'invalid_chat' }, { status: 400 });
  }

  // Ensure agentSessions is present
  if (!chat.agentSessions) chat.agentSessions = {};

  try { await mergeChat(userId, chat); }
  catch (error) {
    if (error instanceof ChatSyncError) return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
    throw error;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
  if (!token) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

  const userId = getUserId(token);
  const chatId = req.nextUrl.searchParams.get('id');
  if (!chatId) return NextResponse.json({ ok: false, error: 'missing_id' }, { status: 400 });

  await deleteChat(userId, chatId);
  try { deleteOrchestrationsForChat(userId, chatId); } catch { /* ignore */ }
  return NextResponse.json({ ok: true });
}
