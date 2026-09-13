import { expect, test } from '@playwright/test';

test('shows an actionable message when GitHub allowlist is not configured', async ({ page }) => {
  await page.goto('/login?error=GitHubAllowlistNotConfigured');

  await expect(page.getByText(
    'GitHub login is not configured. Set GITHUB_ALLOWED_EMAILS or ADMIN_EMAILS in the environment configuration, then restart the service.',
  )).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
});

test('exposes GitHub OAuth only when both GitHub credentials are configured', async ({ request }) => {
  const response = await request.get('/api/auth/providers');
  expect(response.ok()).toBeTruthy();

  const providers = await response.json() as Record<string, { id: string }>;
  const githubConfigured = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  expect(Boolean(providers.github)).toBe(githubConfigured);
});
