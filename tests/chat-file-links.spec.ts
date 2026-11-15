import { expect, test } from '@playwright/test';
import { installMobileChatFixture, loginMobileFixture, TEST_AGENT } from './helpers/mobileChatFixture';

for (const width of [1280, 390]) {
  test(`opens the agent file and scrolls to its source line at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await installMobileChatFixture(page);
    await page.route('**/api/chats?id=mobile-chat', async route => {
      await route.fulfill({ json: { ok: true, chat: {
        id: 'mobile-chat', name: 'File references', ts: 1000, agentSessions: {},
        messages: [{ id: 'file-reply', type: 'agent', agentId: TEST_AGENT.id, ts: 1001,
          parts: [{ kind: 'text', text: '[Open source](src/example.md#L80)\n\nSee `src/example.md:31`.\n\nThen src/example.md:65.\n\n[Read more](https://example.com/readme.md#L80)' }],
          content: 'Source references' }, { id: 'welcome', type: 'user', content: 'Show the file', ts: 1000 }],
      } } });
    });
    await page.route('**/api/markdown**', async route => {
      const query = new URL(route.request().url()).searchParams;
      expect(query.get('agentId')).toBe(TEST_AGENT.id);
      if (!query.has('path')) return route.fulfill({ json: { files: [] } });
      expect(query.get('path')).toBe('src/example.md');
      await route.fulfill({ json: { kind: 'markdown', content: Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n') } });
    });
    await loginMobileFixture(page);
    await expect(page.getByRole('link', { name: 'Read more' })).toHaveAttribute('href', 'https://example.com/readme.md#L80');
    const panel = page.locator('.filesRightPanel');
    const open = page.getByRole('button', { name: 'Open source' });
    await open.click();
    await expect(panel.locator('[data-file-line-target]')).toContainText('Line 80');
    await expect(panel.locator('[data-file-line-target]')).toBeInViewport();
    const bounds = await panel.boundingBox();
    expect(bounds?.x).toBeGreaterThan(0);
    expect(Math.round(bounds!.x + bounds!.width)).toBe(width);
    if (width > 900) {
      await expect(page.locator('.composerTextarea')).toBeVisible();
      await page.getByRole('button', { name: 'src/example.md:31' }).click();
      await expect(panel.locator('[data-file-line-target]')).toContainText('Line 31');
      await expect(panel.locator('[data-file-line-target]')).toBeInViewport();
      await page.getByRole('button', { name: 'src/example.md:65' }).click();
      await expect(panel.locator('[data-file-line-target]')).toContainText('Line 65');
    }
    await page.getByRole('button', { name: 'Close files panel' }).click();
    await expect(panel).toHaveCount(0);
    if (width < 900) await expect(open).toBeFocused();
  });
}
