/**
 * Test script for compareAndRecover logic.
 * Uses the real SQLite chatStore to seed data and verify recovery.
 *
 * Run: npx tsx test-recovery.ts
 */

import { getChat, saveChat, deleteChat, StoredChat } from '../lib/chatStore';

/* ── Inline copy of compareAndRecover (same logic as route.ts) ── */

async function compareAndRecover(
  userId: string,
  chatId: string | undefined,
  agentId: string,
  replayMessages: { role: 'user' | 'agent'; text: string }[],
): Promise<{
  recoveredMessages?: { type: 'agent'; content: string; agentId: string; ts: number }[];
  pendingUserMessage?: string;
}> {
  if (!chatId) return {};

  const chat = await getChat(userId, chatId);
  if (!chat || chat.messages.length === 0) return {};

  const lastUserMsg = [...chat.messages].reverse().find(m => m.type === 'user');
  if (!lastUserMsg) return {};

  const lastStoredMsg = chat.messages[chat.messages.length - 1];
  const lastStoredIsUser = lastStoredMsg.type === 'user';

  if (!lastStoredIsUser) return {};

  const userText = lastUserMsg.content;
  let lastUserIdx = -1;
  for (let i = replayMessages.length - 1; i >= 0; i--) {
    if (replayMessages[i].role === 'user' && replayMessages[i].text === userText) {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx >= 0) {
    const agentAfter = replayMessages.slice(lastUserIdx + 1).filter(m => m.role === 'agent' && m.text);
    if (agentAfter.length > 0) {
      const replyText = agentAfter[agentAfter.length - 1].text;
      const ts = Date.now();
      const recovered = [{ type: 'agent' as const, content: replyText, agentId, ts }];
      chat.messages.push({
        id: `recovered-${ts}`,
        type: 'agent',
        content: replyText,
        agentId,
        ts,
      });
      chat.ts = ts;
      await saveChat(userId, chat);
      return { recoveredMessages: recovered };
    }
  }

  return { pendingUserMessage: userText };
}

/* ── Test helpers ── */

const TEST_USER = '__test_recovery__';
const TEST_AGENT = 'test-agent';
let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function cleanup(chatId: string) {
  await deleteChat(TEST_USER, chatId).catch(() => {});
}

async function seedChat(chatId: string, messages: StoredChat['messages']): Promise<void> {
  await saveChat(TEST_USER, {
    id: chatId,
    name: `Test ${chatId}`,
    ts: Date.now(),
    messages,
    agentSessions: {},
  });
}

/* ── Test Cases ── */

async function test1_noChat() {
  console.log('\nTest 1: No chatId → empty result');
  const result = await compareAndRecover(TEST_USER, undefined, TEST_AGENT, []);
  assert(result.recoveredMessages === undefined, 'no recoveredMessages');
  assert(result.pendingUserMessage === undefined, 'no pendingUserMessage');
}

async function test2_emptyChat() {
  console.log('\nTest 2: Empty chat (no messages) → empty result');
  const id = 'test-empty';
  await seedChat(id, []);
  const result = await compareAndRecover(TEST_USER, id, TEST_AGENT, []);
  assert(result.recoveredMessages === undefined, 'no recoveredMessages');
  assert(result.pendingUserMessage === undefined, 'no pendingUserMessage');
  await cleanup(id);
}

async function test3_chatEndsWithAgentReply() {
  console.log('\nTest 3: Last message is agent reply → nothing to recover');
  const id = 'test-agent-last';
  await seedChat(id, [
    { id: '1', type: 'user', content: 'Hello', ts: 1000 },
    { id: '2', type: 'agent', content: 'Hi there!', agentId: TEST_AGENT, ts: 2000 },
  ]);
  const result = await compareAndRecover(TEST_USER, id, TEST_AGENT, [
    { role: 'user', text: 'Hello' },
    { role: 'agent', text: 'Hi there!' },
  ]);
  assert(result.recoveredMessages === undefined, 'no recoveredMessages');
  assert(result.pendingUserMessage === undefined, 'no pendingUserMessage');
  await cleanup(id);
}

async function test4_userMsgNoReply_replayHasReply() {
  console.log('\nTest 4: User sent message, server crashed before saving reply, ACP has the reply → recover');
  const id = 'test-recover';
  await seedChat(id, [
    { id: '1', type: 'user', content: 'Hello', ts: 1000 },
    { id: '2', type: 'agent', content: 'Hi!', agentId: TEST_AGENT, ts: 2000 },
    { id: '3', type: 'user', content: 'What is 2+2?', ts: 3000 },
    // No agent reply saved — server crashed
  ]);
  const replay = [
    { role: 'user' as const, text: 'Hello' },
    { role: 'agent' as const, text: 'Hi!' },
    { role: 'user' as const, text: 'What is 2+2?' },
    { role: 'agent' as const, text: 'The answer is 4.' },
  ];
  const result = await compareAndRecover(TEST_USER, id, TEST_AGENT, replay);
  assert(result.recoveredMessages !== undefined, 'has recoveredMessages');
  assert(result.recoveredMessages?.length === 1, 'exactly 1 recovered message');
  assert(result.recoveredMessages?.[0]?.content === 'The answer is 4.', 'correct recovered content');
  assert(result.pendingUserMessage === undefined, 'no pendingUserMessage');

  // Verify it was saved to SQLite
  const chat = await getChat(TEST_USER, id);
  const lastMsg = chat!.messages[chat!.messages.length - 1];
  assert(lastMsg.type === 'agent', 'last saved msg is agent');
  assert(lastMsg.content === 'The answer is 4.', 'saved content matches');
  await cleanup(id);
}

async function test5_userMsgNoReply_replayAlsoNoReply() {
  console.log('\nTest 5: User sent message, ACP also has no reply → pendingUserMessage (re-send)');
  const id = 'test-pending';
  await seedChat(id, [
    { id: '1', type: 'user', content: 'Hello', ts: 1000 },
    { id: '2', type: 'agent', content: 'Hi!', agentId: TEST_AGENT, ts: 2000 },
    { id: '3', type: 'user', content: 'Explain quantum physics', ts: 3000 },
  ]);
  const replay = [
    { role: 'user' as const, text: 'Hello' },
    { role: 'agent' as const, text: 'Hi!' },
    // No replay of 3rd user message or reply — it was never sent
  ];
  const result = await compareAndRecover(TEST_USER, id, TEST_AGENT, replay);
  assert(result.recoveredMessages === undefined, 'no recoveredMessages');
  assert(result.pendingUserMessage === 'Explain quantum physics', 'correct pendingUserMessage');
  await cleanup(id);
}

async function test6_userMsgNoReply_emptyReplay() {
  console.log('\nTest 6: User sent message, empty replay (agent restarted fresh) → pendingUserMessage');
  const id = 'test-empty-replay';
  await seedChat(id, [
    { id: '1', type: 'user', content: 'Write me a poem', ts: 1000 },
  ]);
  const result = await compareAndRecover(TEST_USER, id, TEST_AGENT, []);
  assert(result.recoveredMessages === undefined, 'no recoveredMessages');
  assert(result.pendingUserMessage === 'Write me a poem', 'correct pendingUserMessage');
  await cleanup(id);
}

async function test7_onlySystemMessages() {
  console.log('\nTest 7: Chat with only system messages → nothing to recover');
  const id = 'test-system-only';
  await seedChat(id, [
    { id: '1', type: 'system', content: 'Welcome', ts: 0 },
  ]);
  const result = await compareAndRecover(TEST_USER, id, TEST_AGENT, []);
  assert(result.recoveredMessages === undefined, 'no recoveredMessages');
  assert(result.pendingUserMessage === undefined, 'no pendingUserMessage');
  await cleanup(id);
}

async function test8_chatNotFound() {
  console.log('\nTest 8: chatId does not exist in DB → empty result');
  const result = await compareAndRecover(TEST_USER, 'nonexistent-chat-id', TEST_AGENT, [
    { role: 'user', text: 'hello' },
    { role: 'agent', text: 'world' },
  ]);
  assert(result.recoveredMessages === undefined, 'no recoveredMessages');
  assert(result.pendingUserMessage === undefined, 'no pendingUserMessage');
}

async function test9_multipleAgentReplies_recoversLast() {
  console.log('\nTest 9: Replay has multiple extra agent replies → recovers the last one');
  const id = 'test-multi-replay';
  await seedChat(id, [
    { id: '1', type: 'user', content: 'Step 1', ts: 1000 },
    // Server crashed, missed both agent replies
  ]);
  const replay = [
    { role: 'user' as const, text: 'Step 1' },
    { role: 'agent' as const, text: 'First part of answer...' },
    { role: 'agent' as const, text: 'Second part with more detail.' },
  ];
  const result = await compareAndRecover(TEST_USER, id, TEST_AGENT, replay);
  assert(result.recoveredMessages !== undefined, 'has recoveredMessages');
  assert(result.recoveredMessages?.length === 1, 'exactly 1 recovered (last agent)');
  assert(result.recoveredMessages?.[0]?.content === 'Second part with more detail.', 'recovers the last agent message');
  await cleanup(id);
}

/* ── Runner ── */

async function main() {
  console.log('=== compareAndRecover Test Suite ===');
  await test1_noChat();
  await test2_emptyChat();
  await test3_chatEndsWithAgentReply();
  await test4_userMsgNoReply_replayHasReply();
  await test5_userMsgNoReply_replayAlsoNoReply();
  await test6_userMsgNoReply_emptyReplay();
  await test7_onlySystemMessages();
  await test8_chatNotFound();
  await test9_multipleAgentReplies_recoversLast();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
