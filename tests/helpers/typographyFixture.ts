import type { Page } from '@playwright/test';
import type { ChatMessage } from '../../app/features/chat/chatTypes';
import { installMobileChatFixture } from './mobileChatFixture';
import { chatSaveAcknowledgement } from './chatSaveFixture';

export const TYPOGRAPHY_MARKDOWN = `# Stable heading

Stable paragraph with **emphasis** and \`inlineCode\`.

${'Stable prose keeps the original reading size while the available line width changes. '.repeat(12)}

- Stable parent item
  - Stable nested item

> Stable quoted paragraph.

| Label | Detail |
| --- | --- |
| Stable | Stable table value |

\`\`\`ts
const stable = "${'wideColumn'.repeat(30)}";
\`\`\`
`;

export function typographyChat() {
  const messages: ChatMessage[] = [
    { id: 'type-user', type: 'user', content: TYPOGRAPHY_MARKDOWN, ts: 1001 },
    { id: 'type-agent', type: 'agent', agentId: 'alpha', content: TYPOGRAPHY_MARKDOWN, ts: 1002 },
    {
      id: 'type-parts', type: 'agent', agentId: 'alpha',
      content: TYPOGRAPHY_MARKDOWN, ts: 1003,
      parts: [{ kind: 'text', text: TYPOGRAPHY_MARKDOWN }],
    },
  ];
  return { id: 'mobile-chat', name: 'Typography acceptance', ts: 1000, messages, agentSessions: {} };
}

export async function installTypographyFixture(page: Page) {
  await installMobileChatFixture(page);
  const chat = typographyChat();
  let streaming = false;
  let completed = false;
  let additions = '';
  let nextPollGate: { waiting: () => void; released: Promise<void> } | null = null;
  await page.route('**/api/chats**', async (route) => {
    const request = route.request();
    const id = new URL(request.url()).searchParams.get('id');
    await route.fulfill({
      json: request.method() === 'GET'
        ? id
          ? { ok: true, chat }
          : { ok: true, chats: [{ id: chat.id, name: chat.name, ts: chat.ts }], lastChatId: chat.id }
        : chatSaveAcknowledgement(request.postDataJSON()),
    });
  });
  await page.route('**/api/acp', async (route) => {
    const body: { action?: string } = route.request().postDataJSON();
    if (body.action === 'send') {
      streaming = true;
      await route.fulfill({
        json: { ok: true, sessionId: 'type-session', turn: { id: 'type-turn' } },
      });
      return;
    }
    if (body.action === 'poll' && streaming) {
      const gate = nextPollGate;
      nextPollGate = null;
      if (gate) {
        gate.waiting();
        await gate.released;
      }
      const text = TYPOGRAPHY_MARKDOWN + additions;
      await route.fulfill({
        json: {
          ok: true,
          activeTurn: {
            id: 'type-turn', fullText: text, done: completed,
            phase: completed ? 'idle-ready' : 'replying',
            statusText: completed ? '' : 'Generating',
            events: [{ type: 'text_chunk', text, ts: 1004 }],
          },
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.route('**/api/markdown**', async (route) => {
    const path = new URL(route.request().url()).searchParams.get('path');
    if (!path) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      json: { path, content: TYPOGRAPHY_MARKDOWN, kind: 'markdown', mtime: '2026-09-18T00:00:00Z' },
    });
  });
  await page.route('**/api/share**', (route) => route.fulfill({
    json: { ok: true, chat: {
      shareId: 'typography', name: chat.name, sharedBy: 'admin@local',
      sharedAt: 1000, messages: chat.messages,
    } },
  }));
  return {
    holdNextPoll() {
      if (nextPollGate) throw new Error('A typography poll is already held');
      let waiting!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { waiting = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      nextPollGate = { waiting, released };
      return { started, release };
    },
    append() { additions += '\n\nAdditional streaming paragraph.'; },
    finish() { completed = true; },
  };
}
