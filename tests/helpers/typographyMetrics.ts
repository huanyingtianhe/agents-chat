import { expect, type Page } from '@playwright/test';

export function captureTypography(roots: Record<string, string>) {
  const rect = (element: Element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  const typography: Record<string, {
    fontSize: string; fontFamily: string; lineHeight: string;
    width: number; height: number; textAdjust: string;
  }> = {};
  const containers: Record<string, ReturnType<typeof rect>> = {};
  const targets = ['h1', 'p', 'li', 'li li', 'blockquote p', 'td', 'p code', 'pre code'];
  for (const [name, selector] of Object.entries(roots)) {
    const root = document.querySelector(selector);
    if (!root) throw new Error(`Missing typography root: ${name} (${selector})`);
    containers[name] = rect(root);
    for (const target of targets) {
      const element = root.querySelector(target);
      if (!element) throw new Error(`Missing typography target: ${name} ${target}`);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node && !node.textContent?.trim()) node = walker.nextNode();
      if (!node?.textContent) throw new Error(`Missing text: ${name} ${target}`);
      const start = node.textContent.search(/\S/);
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, Math.min(start + 4, node.textContent.length));
      const boxes = Array.from(range.getClientRects());
      if (boxes.length !== 1 || boxes[0].width <= 0 || boxes[0].height <= 0) {
        throw new Error(`Expected one nonzero text fragment: ${name} ${target}`);
      }
      const style = getComputedStyle(element);
      typography[`${name}:${target}`] = {
        fontSize: style.fontSize, fontFamily: style.fontFamily, lineHeight: style.lineHeight,
        width: boxes[0].width, height: boxes[0].height,
        textAdjust: style.getPropertyValue('text-size-adjust')
          || style.getPropertyValue('-webkit-text-size-adjust'),
      };
    }
  }
  const viewport = window.visualViewport;
  const chrome: Record<string, {
    bounds: ReturnType<typeof rect>; fontSize: string;
  }> = {};
  for (const selector of ['.chatPageRoot .page', '.header', '.composerTextarea']) {
    const element = document.querySelector(selector);
    if (element) chrome[selector] = {
      bounds: rect(element), fontSize: getComputedStyle(element).fontSize,
    };
  }
  const rootStyle = getComputedStyle(document.documentElement);
  return {
    typography, containers, chrome,
    rootTextAdjust: rootStyle.getPropertyValue('text-size-adjust')
      || rootStyle.getPropertyValue('-webkit-text-size-adjust'),
    viewport: {
      width: innerWidth, height: innerHeight,
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      devicePixelRatio, mobileLayout: matchMedia('(max-width: 900px)').matches,
      orientation: matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait',
      visual: viewport ? {
        width: viewport.width, height: viewport.height, scale: viewport.scale,
        offsetTop: viewport.offsetTop, offsetLeft: viewport.offsetLeft,
      } : null,
    },
  };
}

export type TypographySample = ReturnType<typeof captureTypography>;
export type TypographyObservation = {
  state: string; time: number; sample: TypographySample;
};

export async function settledTypography(
  page: Page, roots: Record<string, string>, state: string,
  observations: TypographyObservation[],
): Promise<TypographySample> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  let previous = '';
  let since = 0;
  let count = 0;
  let latest: TypographySample | undefined;
  await expect.poll(async () => {
    latest = await page.evaluate(captureTypography, roots);
    const now = Date.now();
    observations.push({ state, time: now, sample: latest });
    const signature = JSON.stringify({
      typography: latest.typography,
      containers: Object.values(latest.containers).map(({ width, height }) => ({ width, height })),
      viewport: latest.viewport,
    });
    if (signature !== previous) {
      previous = signature;
      since = now;
      count = 1;
    } else count++;
    return count >= 3 ? now - since : 0;
  }, { timeout: 10_000, intervals: [100] }).toBeGreaterThanOrEqual(300);
  if (!latest) throw new Error('No typography observations collected');
  return latest;
}

export function expectSameTypography(before: TypographySample, after: TypographySample) {
  expect(Object.keys(after.typography)).toEqual(Object.keys(before.typography));
  for (const [key, expected] of Object.entries(before.typography)) {
    const actual = after.typography[key];
    expect(actual.fontSize, key).toBe(expected.fontSize);
    expect(actual.fontFamily, key).toBe(expected.fontFamily);
    expect(actual.lineHeight, key).toBe(expected.lineHeight);
    expect(Math.abs(actual.width - expected.width), `${key} width`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(actual.height - expected.height), `${key} height`).toBeLessThanOrEqual(0.5);
  }
}
