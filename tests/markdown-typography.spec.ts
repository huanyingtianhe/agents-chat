import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { loginMobileFixture } from './helpers/mobileChatFixture';
import { installTypographyFixture, typographyChat } from './helpers/typographyFixture';
import {
  captureTypography, expectSameTypography, settledTypography,
  type TypographyObservation,
} from './helpers/typographyMetrics';

const roots = {
  user: '.message.user .markdownBody',
  agent: '.message.agent:not(:has(.partsStream)) .markdownBody',
  parts: '.partsStream .markdownBody',
};
let observations: TypographyObservation[];
let fixture: Awaited<ReturnType<typeof installTypographyFixture>>;

test.beforeEach(async ({ page }) => {
  observations = [];
  fixture = await installTypographyFixture(page);
});

test.afterEach(async ({ page, browser }, testInfo) => {
  await mkdir(testInfo.outputPath('evidence'), { recursive: true });
  const evidence = [
    {
      name: 'typography-observations.json',
      content: JSON.stringify({
        commit: process.env.GITHUB_SHA || 'unrecorded',
        browser: browser.version(),
        project: testInfo.project.name,
        observations,
      }, null, 2),
      contentType: 'application/json',
    },
    {
      name: 'device-sampler.js',
      content: `(${captureTypography.toString()})(${JSON.stringify(roots)})`,
      contentType: 'application/javascript',
    },
    {
      name: 'synthetic-chat.json',
      content: JSON.stringify(typographyChat(), null, 2),
      contentType: 'application/json',
    },
  ];
  for (const item of evidence) {
    const path = testInfo.outputPath('evidence', item.name);
    await writeFile(path, item.content);
    await testInfo.attach(item.name, { path, contentType: item.contentType });
  }
  if (!page.isClosed()) {
    const path = testInfo.outputPath('evidence', 'final-viewport.png');
    await page.screenshot({ path });
    await testInfo.attach('final-viewport.png', { path, contentType: 'image/png' });
  }
});

for (const portrait of [{ width: 390, height: 844 }, { width: 430, height: 932 }]) {
  for (const landscapeFirst of [false, true]) {
    test(`stable Markdown ${portrait.width} landscape-first=${landscapeFirst}`, async ({ page }) => {
      const landscape = { width: portrait.height, height: portrait.width };
      const start = landscapeFirst ? landscape : portrait;
      const other = landscapeFirst ? portrait : landscape;
      await page.setViewportSize(start);
      await loginMobileFixture(page);
      const baseline = await settledTypography(page, roots, 'initial', observations);
      for (const selector of Object.values(roots)) {
        const message = page.locator(selector).locator('xpath=ancestor::div[contains(@class,"message ")][1]');
        await message.getByRole('button', { name: 'Collapse', exact: true }).click();
      }
      expectSameTypography(baseline, await settledTypography(page, roots, 'collapsed', observations));
      expect(baseline.viewport.visual).not.toBeNull();
      expect(baseline.viewport.visual!.scale).toBeCloseTo(1, 2);
      for (let cycle = 0; cycle < 3; cycle++) {
        for (const size of [other, start]) {
          await page.setViewportSize(size);
          const sample = await settledTypography(page, roots, `cycle-${cycle}-${size.width}`, observations);
          expect(sample.viewport.width).toBe(size.width);
          expect(sample.viewport.mobileLayout).toBe(size.width <= 900);
          expect(sample.viewport.visual?.scale).toBeCloseTo(1, 2);
          expectSameTypography(baseline, sample);
        }
      }
      for (const selector of Object.values(roots)) {
        const message = page.locator(selector).locator('xpath=ancestor::div[contains(@class,"message ")][1]');
        await message.getByRole('button', { name: 'Expand', exact: true }).click();
      }
      expectSameTypography(baseline, await settledTypography(page, roots, 'expanded', observations));
      await page.setViewportSize(other);
      expectSameTypography(baseline, await settledTypography(page, roots, 'expanded-rotated', observations));
    });
  }
}

test('draft and streamed Markdown survive real viewport changes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginMobileFixture(page);
  const composer = page.locator('textarea.composerTextarea');
  await composer.fill('@alpha Typography streaming check');
  await page.getByRole('button', { name: 'Send message' }).click();
  const streamRoots = { stream: '.message.agent:last-child .markdownBody' };
  await expect(page.locator('.message.agent.streamingMessage .partsStream .markdownBody')).toBeVisible();
  const baseline = await settledTypography(page, streamRoots, 'stream-start', observations);
  await composer.fill('Preserve my draft');
  await composer.focus();
  const focused = await settledTypography(page, streamRoots, 'focused-baseline', observations);
  await page.setViewportSize({ width: 844, height: 390 });
  fixture.append();
  await expect(page.locator(streamRoots.stream)).toContainText('Additional streaming paragraph.');
  expectSameTypography(focused, await settledTypography(page, streamRoots, 'stream-landscape', observations));
  await page.setViewportSize({ width: 390, height: 844 });
  fixture.finish();
  await expect(page.locator('.message.agent:last-child')).not.toHaveClass(/streamingMessage/);
  await expect(composer).toHaveValue('Preserve my draft');
  expectSameTypography(baseline, await settledTypography(page, streamRoots, 'stream-complete', observations));
});

test('shared Markdown inherits the policy across orientation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginMobileFixture(page);
  await page.goto('/share/typography');
  const shareRoots = { share: '.shareMsg.agent .shareMarkdown' };
  await expect(page.locator(shareRoots.share).first()).toBeVisible();
  const baseline = await settledTypography(page, shareRoots, 'share-portrait', observations);
  await page.setViewportSize({ width: 844, height: 390 });
  expectSameTypography(baseline, await settledTypography(page, shareRoots, 'share-landscape', observations));
});

test('file Markdown inherits the policy without changing the viewer layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginMobileFixture(page);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('tab', { name: 'Files' }).click();
  await page.getByRole('button', { name: 'Files agent' }).click();
  await page.getByRole('option', { name: 'Alpha Agent' }).click();
  await page.getByRole('button', { name: 'README.md' }).click();
  const fileRoots = { file: '.mobileMarkdownViewer' };
  await expect(page.locator(fileRoots.file)).toBeVisible();
  const baseline = await settledTypography(page, fileRoots, 'file-portrait', observations);
  await page.setViewportSize({ width: 844, height: 390 });
  expectSameTypography(baseline, await settledTypography(page, fileRoots, 'file-landscape', observations));
});

test('desktop resizing preserves typography and sidebar mode', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Desktop-only grid invariant');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await loginMobileFixture(page);
  const baseline = await settledTypography(page, roots, 'desktop-1440', observations);
  for (const width of [1100, 1600, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expectSameTypography(baseline, await settledTypography(page, roots, `desktop-${width}`, observations));
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();
    await expect(page.locator('.participantsSidebar')).toBeVisible();
  }
});

test('@policy declares root text adjustment without restricting user zoom', async ({ page }, testInfo) => {
  await loginMobileFixture(page);
  const source = readFileSync('app/globals.css', 'utf8');
  const rootRule = source.match(/html,\s*body\s*\{([^}]+)\}/)?.[1];
  expect(rootRule).toBeDefined();
  expect(rootRule).toMatch(/-webkit-text-size-adjust:\s*100%/);
  expect(rootRule).toMatch(/(?:^|[;\n])\s*text-size-adjust:\s*100%/);
  const stylesheets = await page.locator('link[rel="stylesheet"]').evaluateAll((links) =>
    [...new Set(links.map((link) => link.getAttribute('href')).filter((href): href is string => !!href))],
  );
  expect(stylesheets.length).toBeGreaterThan(0);
  const compiledCss = (await Promise.all(stylesheets.map(async (href) => {
    const response = await page.request.get(href);
    expect(response.ok(), `Stylesheet ${href}`).toBe(true);
    return response.text();
  }))).join('\n');
  await mkdir(testInfo.outputPath('evidence'), { recursive: true });
  await writeFile(testInfo.outputPath('evidence', 'served-stylesheets.css'), compiledCss);
  const compiledRootRule = compiledCss.match(/(?:html\s*,\s*body|body\s*,\s*html)\s*\{([^}]+)\}/)?.[1];
  expect(compiledRootRule, 'Root rule in served CSS').toBeDefined();
  expect(compiledRootRule, 'iOS prefix must survive CSS compilation').toMatch(/-webkit-text-size-adjust:\s*100%/);
  expect(compiledRootRule).toMatch(/(?:^|[;\n])\s*text-size-adjust:\s*100%/);
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(viewport).toContain('width=device-width');
  expect(viewport).toMatch(/(?:^|,)\s*initial-scale=1(?:,|$)/);
  expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|(?:minimum|maximum)-scale\s*=/);
  const sample = await settledTypography(page, roots, 'policy', observations);
  for (const value of [sample.rootTextAdjust, ...Object.values(sample.typography).map(item => item.textAdjust)]) {
    if (value !== '') expect(value).toBe('100%');
  }
});
