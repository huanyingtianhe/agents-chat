import { expect, test, type Page } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture } from './helpers/mobileChatFixture';

const portrait = { width: 390, height: 844 };
const landscape = { width: 844, height: 390 };
const longParagraph = Array.from({ length: 1400 }, (_, i) => `reading${String(i).padStart(4, '0')}`).join(' ');
const paragraphSelector = '.message.agent .markdownBody p';

async function settleLayout(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }));
}

async function installReadingFixture(page: Page) {
  await installMobileChatFixture(page);
  const chat = {
    id: 'mobile-chat', name: 'Reading position', ts: 1000, agentSessions: {},
    messages: [
      { id: 'reading-user', type: 'user', content: 'Reading position fixture', ts: 1001 },
      { id: 'reading-long', type: 'agent', agentId: 'alpha', content: longParagraph, ts: 1002 },
      {
        id: 'reading-tail', type: 'agent', agentId: 'alpha', ts: 1003,
        content: Array.from({ length: 35 }, (_, i) =>
          `Later paragraph ${i}. ${'Later content changes its wrapping across orientations. '.repeat(5)}`,
        ).join('\n\n'),
      },
    ],
  };
  await page.route('**/api/chats**', async (route) => {
    const request = route.request();
    const id = new URL(request.url()).searchParams.get('id');
    await route.fulfill({ json: request.method() === 'GET'
      ? id ? { ok: true, chat } : {
        ok: true, chats: [{ id: chat.id, name: chat.name, ts: chat.ts }], lastChatId: chat.id,
      }
      : { ok: true } });
  });
}

async function captureHistoricalPoint(page: Page, fraction = 0.5) {
  await page.locator(paragraphSelector).first().evaluate((paragraph, position) => {
    const chat = paragraph.closest<HTMLElement>('.chatContainer');
    if (!chat) throw new Error('Missing chat container');
    const rect = paragraph.getBoundingClientRect();
    if (rect.height < chat.clientHeight * 2) throw new Error('Paragraph is not long enough for internal anchoring');
    chat.scrollTop += rect.top + rect.height * position - chat.getBoundingClientRect().top - chat.clientHeight;
  }, fraction);
  await settleLayout(page);
  return page.locator(paragraphSelector).first().evaluate((paragraph) => {
    const chat = paragraph.closest<HTMLElement>('.chatContainer');
    const text = paragraph.firstChild;
    if (!chat || !(text instanceof Text)) throw new Error('Missing plain-text anchor fixture');
    const bottom = chat.getBoundingClientRect().top + chat.clientTop + chat.clientHeight;
    const range = document.createRange();
    let offset = -1;
    let pointBottom = 0;
    // Independent, exhaustive oracle; production code must not scan every character.
    for (let i = 0; i < text.length; i++) {
      if (/\s/.test(text.data[i])) continue;
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const rect = range.getBoundingClientRect();
      if (rect.bottom > bottom + 0.01) break;
      if (rect.width > 0 && rect.bottom > chat.getBoundingClientRect().top) {
        offset = i;
        pointBottom = rect.bottom;
      }
    }
    if (offset < 1) throw new Error('No fully visible historical text position');
    return { offset, gap: bottom - pointBottom, character: text.data[offset] };
  });
}

async function historicalPointError(page: Page, point: { offset: number; gap: number; character: string }) {
  return page.locator(paragraphSelector).first().evaluate((paragraph, anchor) => {
    const chat = paragraph.closest<HTMLElement>('.chatContainer');
    const text = paragraph.firstChild;
    if (!chat || !(text instanceof Text) || text.data[anchor.offset] !== anchor.character) {
      throw new Error('Historical text identity changed');
    }
    const range = document.createRange();
    range.setStart(text, anchor.offset);
    range.setEnd(text, anchor.offset + 1);
    const rect = range.getBoundingClientRect();
    const viewport = chat.getBoundingClientRect();
    const bottom = viewport.top + chat.clientTop + chat.clientHeight;
    if (rect.bottom < viewport.top || rect.top > bottom) return Number.MAX_SAFE_INTEGER;
    return Math.abs(bottom - rect.bottom - anchor.gap);
  }, point);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(portrait);
  await installReadingFixture(page);
  await loginMobileFixture(page);
  await expect(page.locator(paragraphSelector).first()).toHaveText(longParagraph);
  await settleLayout(page);
});

test('keeps latest messages at the bottom through orientation round trips', async ({ page }) => {
  const chat = page.locator('.chatContainer');
  await chat.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await settleLayout(page);
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const size of [landscape, portrait]) {
      await page.setViewportSize(size);
      await settleLayout(page);
      await expect.poll(() => chat.evaluate((element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop,
      ), { message: `cycle ${cycle}, viewport ${size.width}: latest stays at bottom` }).toBeLessThanOrEqual(4);
    }
  }
});

test('preserves bottom-visible text inside a long historical paragraph', async ({ page }) => {
  const point = await captureHistoricalPoint(page);
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const size of [landscape, portrait]) {
      await page.setViewportSize(size);
      await settleLayout(page);
      await expect.poll(() => historicalPointError(page, point), {
        message: `cycle ${cycle}, viewport ${size.width}: same character remains bottom-anchored`,
      }).toBeLessThanOrEqual(2);
    }
  }
});

test('uses the new reading point after the user scrolls in landscape', async ({ page }) => {
  const original = await captureHistoricalPoint(page);
  await page.setViewportSize(landscape);
  await settleLayout(page);
  const moved = await captureHistoricalPoint(page, 0.7);
  expect(moved.offset).not.toBe(original.offset);
  await page.setViewportSize(portrait);
  await settleLayout(page);
  await expect.poll(() => historicalPointError(page, moved)).toBeLessThanOrEqual(2);
});
