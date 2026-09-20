import { expect, test, type Page } from '@playwright/test';
import { loginMobileFixture } from './helpers/mobileChatFixture';
import { installTypographyFixture } from './helpers/typographyFixture';
import type { ChatMessage } from '../app/features/chat/chatTypes';
import { settleChatLayout as settleLayout } from './helpers/chatLayout';

const portrait = { width: 390, height: 844 };
const landscape = { width: 844, height: 390 };
const longParagraph = Array.from({ length: 1400 }, (_, i) => `reading${String(i).padStart(4, '0')}`).join(' ');
const paragraphSelector = '.message.agent .markdownBody p';

async function settleUserScroll(page: Page) {
  await page.locator('.chatContainer').evaluate((element) => new Promise<void>((resolve, reject) => {
    let previous = element.scrollTop;
    let stable = 0;
    let frames = 0;
    const sample = () => {
      stable = Math.abs(element.scrollTop - previous) < 0.25 ? stable + 1 : 0;
      previous = element.scrollTop;
      if (stable >= 4) resolve();
      else if (++frames >= 90) reject(new Error('User scroll did not settle'));
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}

async function installReadingFixture(page: Page) {
  const streaming = await installTypographyFixture(page);
  const messages: ChatMessage[] = [
    { id: 'reading-user', type: 'user', content: 'Reading position fixture', ts: 1001 },
    { id: 'reading-long', type: 'agent', agentId: 'alpha', content: longParagraph, ts: 1002 },
    {
      id: 'reading-tail', type: 'agent', agentId: 'alpha', ts: 1003,
      content: Array.from({ length: 35 }, (_, i) =>
        `Later paragraph ${i}. ${'Later content changes its wrapping across orientations. '.repeat(5)}`,
      ).join('\n\n'),
    },
  ];
  const chat = {
    id: 'mobile-chat', name: 'Reading position', ts: 1000, agentSessions: {},
    messages,
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
  return {
    ...streaming,
    replaceBody(content: string) { chat.messages[1].content = content; },
    shorten() { chat.messages = [messages[0]]; },
  };
}

async function captureHistoricalPoint(page: Page, fraction = 0.5, selector = paragraphSelector) {
  const delta = await page.locator(selector).first().evaluate((paragraph, position) => {
    const chat = paragraph.closest<HTMLElement>('.chatContainer');
    if (!chat) throw new Error('Missing chat container');
    const rect = paragraph.getBoundingClientRect();
    if (rect.height < chat.clientHeight * 2) throw new Error('Paragraph is not long enough for internal anchoring');
    return rect.top + rect.height * position - chat.getBoundingClientRect().top - chat.clientHeight;
  }, fraction);
  const chat = page.locator('.chatContainer');
  await chat.evaluate((element, distance) => { element.scrollTop += distance; }, delta);
  await settleLayout(page);
  return readHistoricalPoint(page, selector);
}

async function readHistoricalPoint(page: Page, selector = paragraphSelector) {
  return page.locator(selector).first().evaluate((paragraph) => {
    const chat = paragraph.closest<HTMLElement>('.chatContainer');
    if (!chat) throw new Error('Missing anchor fixture');
    const viewport = chat.getBoundingClientRect();
    const bottom = viewport.top + chat.clientTop + chat.clientHeight;
    const pre = paragraph.closest('pre');
    const clip = (pre ?? paragraph.closest('table'))?.getBoundingClientRect() ?? viewport;
    const range = document.createRange();
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let offset = -1;
    let pointBottom = 0;
    let character = '';
    let base = 0;
    // Independent, exhaustive oracle; production code must not scan every character.
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      for (let i = 0; i < text.length; i++) {
        if (/\s/.test(text.data[i])) continue;
        range.setStart(text, i);
        range.setEnd(text, i + 1);
        const rect = range.getBoundingClientRect();
        if (rect.bottom > bottom + 0.01) break;
        if (rect.width > 0 && rect.bottom > viewport.top && rect.right > clip.left && rect.left < clip.right
          && (!pre || rect.bottom > pointBottom + 0.01)) {
          offset = base + i;
          pointBottom = rect.bottom;
          character = text.data[i];
        }
      }
      base += text.length;
    }
    if (offset < 1) throw new Error('No fully visible historical text position');
    return { offset, gap: bottom - pointBottom, character };
  });
}

async function historicalPointError(page: Page, point: { offset: number; gap: number; character: string }, selector = paragraphSelector) {
  return page.locator(selector).first().evaluate((paragraph, anchor) => {
    const chat = paragraph.closest<HTMLElement>('.chatContainer');
    const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let offset = anchor.offset;
    let text: Text | null = null;
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (offset < node.length) { text = node; break; }
      offset -= node.length;
    }
    if (!chat || !text || text.data[offset] !== anchor.character) {
      throw new Error('Historical text identity changed');
    }
    const range = document.createRange();
    range.setStart(text, offset);
    range.setEnd(text, offset + 1);
    const rect = range.getBoundingClientRect();
    const viewport = chat.getBoundingClientRect();
    const bottom = viewport.top + chat.clientTop + chat.clientHeight;
    if (rect.bottom < viewport.top || rect.top > bottom) return Number.MAX_SAFE_INTEGER;
    return Math.abs(bottom - rect.bottom - anchor.gap);
  }, point);
}

let fixture: Awaited<ReturnType<typeof installReadingFixture>>;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(portrait);
  fixture = await installReadingFixture(page);
  await loginMobileFixture(page);
  await expect(page.locator(paragraphSelector).first()).toHaveText(longParagraph);
  await settleLayout(page);
});

test.afterEach(async ({ page }, testInfo) => {
  if (page.isClosed()) return;
  const geometry = await page.evaluate(() => {
    const chat = document.querySelector<HTMLElement>('.chatContainer');
    return {
      viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale },
      chat: chat ? {
        top: chat.scrollTop, height: chat.clientHeight, width: chat.clientWidth,
        contentHeight: chat.scrollHeight,
        bottomDistance: chat.scrollHeight - chat.clientHeight - chat.scrollTop,
      } : null,
    };
  });
  await testInfo.attach('final-reading-geometry', {
    body: JSON.stringify(geometry, null, 2), contentType: 'application/json',
  });
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

test('keeps the anchor when crossing the desktop breakpoint from landscape', async ({ page }) => {
  await page.setViewportSize({ width: 932, height: 430 });
  await settleLayout(page);
  const point = await captureHistoricalPoint(page);
  for (const size of [{ width: 430, height: 932 }, { width: 932, height: 430 }, portrait]) {
    await page.setViewportSize(size);
    await settleLayout(page);
    await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
  }
});

test('updates the anchor after keyboard scrolling rather than restoring stale history', async ({ page }) => {
  const original = await captureHistoricalPoint(page, 0.65);
  const chat = page.locator('.chatContainer');
  await chat.focus();
  const previous = await chat.evaluate((element) => element.scrollTop);
  await page.keyboard.press('PageUp');
  await expect.poll(() => chat.evaluate((element) => element.scrollTop)).toBeLessThan(previous - 20);
  await settleUserScroll(page);
  const point = await readHistoricalPoint(page);
  expect(point.offset).not.toBe(original.offset);
  await page.setViewportSize(landscape);
  await settleLayout(page);
  await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
});

test('accepts real wheel input while a viewport transition is settling', async ({ page, browserName, isMobile }) => {
  test.skip(browserName === 'webkit' && isMobile, 'Playwright does not support mouse wheel in mobile WebKit');
  const original = await captureHistoricalPoint(page, 0.65);
  await page.setViewportSize(landscape);
  const box = await page.locator('.chatContainer').boundingBox();
  if (!box) throw new Error('Missing scroll viewport');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -200);
  await expect.poll(async () => (await readHistoricalPoint(page)).offset).toBeLessThan(original.offset - 20);
  await settleLayout(page);
  const point = await readHistoricalPoint(page);
  expect(point.offset).not.toBe(original.offset);
  await page.setViewportSize(portrait);
  await settleLayout(page);
  await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
});

test('preserves logical text identity after rendered nodes are replaced', async ({ page }) => {
  const point = await captureHistoricalPoint(page);
  await page.locator(paragraphSelector).first().evaluate((paragraph) => {
    const text = paragraph.textContent || '';
    paragraph.replaceChildren(...text.split(/(reading\d+)/).map((part) => {
      if (!part.trim()) return document.createTextNode(part);
      const span = document.createElement('span');
      span.textContent = part;
      return span;
    }));
  });
  await settleLayout(page);
  await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
  await page.setViewportSize(landscape);
  await settleLayout(page);
  await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
});

test('maintains the anchor during multiple composer-height changes', async ({ page }) => {
  const point = await captureHistoricalPoint(page);
  const composer = page.locator('textarea.composerTextarea');
  for (const draft of ['A short draft', Array.from({ length: 9 }, (_, i) => `Draft line ${i}`).join('\n'), '']) {
    await composer.fill(draft);
    await settleLayout(page);
    await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
  }
});

test('does not overwrite a new reading position before resize observation is delivered', async ({ page }) => {
  const chat = page.locator('.chatContainer');
  const requested = await chat.evaluate((element) => {
    document.querySelector<HTMLElement>('.page')!.style.setProperty('--app-viewport-height', '600px');
    element.scrollTop = Math.floor((element.scrollHeight - element.clientHeight) / 2);
    return element.scrollTop;
  });
  await settleLayout(page);
  await expect.poll(() => chat.evaluate((element) => element.scrollTop)).toBe(requested);
  const point = await readHistoricalPoint(page);
  await page.setViewportSize(landscape);
  await settleLayout(page);
  await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
});

for (const delayedFirstChunk of [false, true]) {
  test(`keeps historical text fixed during streaming then follows an explicit jump (delayed first chunk: ${delayedFirstChunk})`, async ({ page }) => {
    const heldPoll = delayedFirstChunk ? fixture.holdNextPoll() : null;
    const streamedBody = page.locator('.message.agent.streamingMessage .partsStream .markdownBody');
    try {
      await page.locator('textarea.composerTextarea').fill('@alpha Start reading stream');
      await page.getByRole('button', { name: 'Send message' }).click();
      await expect(page.locator('.message.agent.streamingMessage')).toBeVisible();
      if (heldPoll) {
        await heldPoll.started;
        await expect(streamedBody).toHaveCount(0);
      }
    } finally {
      heldPoll?.release();
    }
    // The pending bubble precedes the first poll response and is not a stable scroll baseline.
    await expect(streamedBody).toContainText('Stable heading');
    await settleLayout(page);
    const point = await captureHistoricalPoint(page);
    fixture.append();
    await expect(page.locator('.message.agent:last-child')).toContainText('Additional streaming paragraph.');
    await settleLayout(page);
    await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
    await page.setViewportSize(landscape);
    await settleLayout(page);
    await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
    await page.getByRole('button', { name: 'Jump to latest messages' }).click();
    fixture.append();
    await expect(page.locator('.message.agent:last-child .markdownBody p').filter({
      hasText: 'Additional streaming paragraph.',
    })).toHaveCount(2);
    const chat = page.locator('.chatContainer');
    await expect.poll(() => chat.evaluate((element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop,
    )).toBeLessThanOrEqual(4);
    fixture.finish();
    await expect(page.locator('.message.agent:last-child')).not.toHaveClass(/streamingMessage/);
    await page.setViewportSize(portrait);
    await settleLayout(page);
    await expect.poll(() => chat.evaluate((element) =>
      element.scrollHeight - element.clientHeight - element.scrollTop,
    )).toBeLessThanOrEqual(4);
  });
}

test('keeps short content within the available scroll range', async ({ page }) => {
  fixture.shorten();
  await page.reload();
  const chat = page.locator('.chatContainer');
  await expect(chat.locator('.message')).toHaveCount(1);
  for (const size of [landscape, portrait, landscape, portrait]) {
    await page.setViewportSize(size);
    await settleLayout(page);
    await expect.poll(() => chat.evaluate((element) => element.scrollTop)).toBe(0);
  }
});

test('anchors a visible point inside a tall image', async ({ page }) => {
  await page.route('**/reading-tall.svg', (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="3000"><rect width="600" height="3000" fill="steelblue"/></svg>',
  }));
  fixture.replaceBody('![Tall reading diagram](/reading-tall.svg)');
  await page.reload();
  const image = page.getByAltText('Tall reading diagram');
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalHeight)).toBeGreaterThan(0);
  await settleLayout(page);
  await image.evaluate((element) => {
    const chat = element.closest<HTMLElement>('.chatContainer');
    if (!chat) throw new Error('Missing image chat');
    const rect = element.getBoundingClientRect();
    if (rect.height < chat.clientHeight * 2) throw new Error('Image is not tall enough to exercise an internal reading point');
    chat.scrollTop += rect.top + rect.height * 0.55 - chat.getBoundingClientRect().top - chat.clientHeight;
  });
  await settleLayout(page);
  const fraction = await image.evaluate((element) => {
    const chat = element.closest<HTMLElement>('.chatContainer')!;
    const rect = element.getBoundingClientRect();
    return (chat.getBoundingClientRect().top + chat.clientHeight - rect.top) / rect.height;
  });
  for (const size of [landscape, portrait, landscape, portrait]) {
    await page.setViewportSize(size);
    await settleLayout(page);
    await expect.poll(() => image.evaluate((element, point) => {
      const chat = element.closest<HTMLElement>('.chatContainer')!;
      const rect = element.getBoundingClientRect();
      return Math.abs(chat.getBoundingClientRect().top + chat.clientHeight - rect.top - rect.height * point);
    }, fraction)).toBeLessThanOrEqual(2);
  }
});

test('anchors visible code rather than a horizontally clipped line ending', async ({ page }) => {
  const code = Array.from({ length: 160 }, (_, i) => `line${i}: ${'wideCodeColumn '.repeat(35)}`).join('\n');
  fixture.replaceBody(`\`\`\`text\n${code}\n\`\`\``);
  await page.reload();
  const selector = '.message.agent .markdownBody pre code';
  await expect(page.locator(selector).first()).toContainText('line159:');
  await settleLayout(page);
  const point = await captureHistoricalPoint(page, 0.5, selector);
  for (const size of [landscape, portrait]) {
    await page.setViewportSize(size);
    await settleLayout(page);
    await expect.poll(() => historicalPointError(page, point, selector)).toBeLessThanOrEqual(2);
  }
});

test('keeps the same text in a tall horizontally scrollable table bottom-anchored', async ({ page }) => {
  const table = '| Reading cell | Details |\n| --- | --- |\n'
    + Array.from({ length: 120 }, (_, i) => `| Reading row ${i} | ${'Wide table content '.repeat(8)} |`).join('\n');
  fixture.replaceBody(table);
  await page.reload();
  const selector = '.message.agent .markdownBody table';
  await expect(page.locator(selector).first()).toContainText('Reading row 119');
  await settleLayout(page);
  const point = await captureHistoricalPoint(page, 0.5, selector);
  for (const size of [landscape, portrait]) {
    await page.setViewportSize(size);
    await settleLayout(page);
    await expect.poll(() => historicalPointError(page, point, selector)).toBeLessThanOrEqual(2);
  }
});

test('restores the historical reading point after visiting a file', async ({ page }) => {
  const point = await captureHistoricalPoint(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByRole('button', { name: 'Files agent' }).click();
  await page.getByRole('option', { name: 'Alpha Agent' }).click();
  await page.getByRole('button', { name: 'README.md' }).click();
  await expect(page.locator('.mobileMarkdownViewer')).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('tab', { name: 'Chats' }).click();
  await page.getByRole('button', { name: 'Close active panel' }).click({ position: { x: 380, y: 100 } });
  await expect(page.locator('.chatContainer')).toBeVisible();
  await settleLayout(page);
  await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
});

test('pauses application corrections during multi-touch and rebases afterward', async ({ page }) => {
  await captureHistoricalPoint(page);
  const chat = page.locator('.chatContainer');
  const previous = await chat.evaluate((element) => element.scrollTop);
  await page.evaluate(() => {
    const gesture = new Event('touchstart');
    Object.defineProperty(gesture, 'touches', { value: [{ clientY: 200 }, { clientY: 300 }] });
    window.dispatchEvent(gesture);
    document.querySelector<HTMLElement>('.page')!.style.setProperty('--app-viewport-height', '600px');
  });
  await settleLayout(page);
  await expect.poll(() => chat.evaluate((element) => element.scrollTop)).toBe(previous);
  await page.evaluate(() => {
    const gesture = new Event('touchend');
    Object.defineProperty(gesture, 'touches', { value: [] });
    window.dispatchEvent(gesture);
  });
  const point = await readHistoricalPoint(page);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.page')!.style.setProperty('--app-viewport-height', `${innerHeight}px`);
  });
  await settleLayout(page);
  await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
});

test('preserves reading position after a cancelled scrollbar pointer interaction', async ({ page }) => {
  const point = await captureHistoricalPoint(page);
  await page.locator('.chatContainer').dispatchEvent('pointerdown', { pointerType: 'mouse' });
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerType: 'mouse' })));
  await page.setViewportSize(landscape);
  await settleLayout(page);
  await expect.poll(() => historicalPointError(page, point)).toBeLessThanOrEqual(2);
});

test('keeps a surviving message position after collapsing its long body', async ({ page }) => {
  await captureHistoricalPoint(page);
  const message = page.locator('[data-message-id="reading-long"]');
  await message.getByRole('button', { name: 'Collapse', exact: true }).click();
  await expect(message.getByRole('button', { name: 'Expand', exact: true })).toBeVisible();
  await settleLayout(page);
  const position = await message.evaluate((element) => {
    const chat = element.closest<HTMLElement>('.chatContainer')!;
    const rect = element.getBoundingClientRect();
    const bounds = chat.getBoundingClientRect();
    return { visible: rect.bottom > bounds.top && rect.top < bounds.bottom, atLatest: chat.scrollHeight - chat.clientHeight - chat.scrollTop <= 4 };
  });
  expect(position.visible).toBe(true);
  expect(position.atLatest).toBe(false);
});
