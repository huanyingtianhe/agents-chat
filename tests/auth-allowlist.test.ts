import {
  getGitHubAllowedEmails,
  isGitHubEmailAllowed,
  parseEmailList,
  shouldUseSecureAuthCookies,
} from '../lib/auth';
import { authOptions } from '../app/api/auth/[...nextauth]/route';

function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

expectEqual(
  parseEmailList(' Alice@example.com, bob@example.com , '),
  ['alice@example.com', 'bob@example.com'],
  'normalizes comma-separated emails',
);
expectEqual(
  getGitHubAllowedEmails('alice@example.com,bob@example.com', 'admin@example.com'),
  ['alice@example.com', 'bob@example.com'],
  'uses the explicit GitHub allowlist',
);
expectEqual(
  getGitHubAllowedEmails('', ' Admin@example.com '),
  ['admin@example.com'],
  'falls back to ADMIN_EMAILS',
);
expectEqual(
  getGitHubAllowedEmails('', ''),
  [],
  'returns an empty list when both variables are empty',
);
expectEqual(
  isGitHubEmailAllowed(' ALICE@example.com ', ['alice@example.com']),
  true,
  'matches case-insensitively after trimming',
);
expectEqual(
  isGitHubEmailAllowed('other@example.com', ['alice@example.com']),
  false,
  'denies an email outside the allowlist',
);
expectEqual(
  shouldUseSecureAuthCookies('http://localhost:3010', 'development'),
  false,
  'allows auth cookies on an explicit HTTP development URL',
);
expectEqual(
  shouldUseSecureAuthCookies('https://chat.example.com', 'production'),
  true,
  'keeps auth cookies secure on HTTPS',
);
expectEqual(
  shouldUseSecureAuthCookies(undefined, 'production'),
  true,
  'defaults production auth cookies to secure',
);

async function testSignInCallback(): Promise<void> {
  const signIn = authOptions.callbacks?.signIn;
  if (!signIn) throw new Error('NextAuth signIn callback is not configured');

  const originalGitHubAllowedEmails = process.env.GITHUB_ALLOWED_EMAILS;
  const originalAdminEmails = process.env.ADMIN_EMAILS;

  try {
    process.env.GITHUB_ALLOWED_EMAILS = 'allowed@example.com';
    process.env.ADMIN_EMAILS = 'admin@example.com';
    expectEqual(
      await signIn({
        user: { email: 'allowed@example.com' },
        account: { provider: 'github' },
        profile: { email: 'allowed@example.com' },
      } as never),
      true,
      'allows an email in the GitHub allowlist',
    );
    expectEqual(
      await signIn({
        user: { email: 'other@example.com' },
        account: { provider: 'github' },
        profile: { email: 'other@example.com' },
      } as never),
      false,
      'denies an email outside the GitHub allowlist',
    );

    process.env.GITHUB_ALLOWED_EMAILS = '';
    expectEqual(
      await signIn({
        user: { email: 'admin@example.com' },
        account: { provider: 'github' },
        profile: { email: 'admin@example.com' },
      } as never),
      true,
      'uses ADMIN_EMAILS as the fallback allowlist',
    );

    process.env.ADMIN_EMAILS = '';
    expectEqual(
      await signIn({
        user: { email: 'admin@example.com' },
        account: { provider: 'github' },
        profile: { email: 'admin@example.com' },
      } as never),
      '/login?error=GitHubAllowlistNotConfigured',
      'returns a clear configuration error when both allowlists are empty',
    );
  } finally {
    if (originalGitHubAllowedEmails === undefined) delete process.env.GITHUB_ALLOWED_EMAILS;
    else process.env.GITHUB_ALLOWED_EMAILS = originalGitHubAllowedEmails;
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  }
}

async function testGitHubPrivateEmailJwt(): Promise<void> {
  const jwt = authOptions.callbacks?.jwt;
  if (!jwt) throw new Error('NextAuth jwt callback is not configured');

  const originalFetch = global.fetch;
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  try {
    process.env.ADMIN_EMAILS = 'x12jiang@outlook.com';
    global.fetch = async () => new Response(JSON.stringify([
      { email: 'x12jiang@outlook.com', primary: true, verified: true },
    ]), { status: 200 });

    const token = await jwt({
      token: { email: 'xujxu@users.noreply.github.com' },
      user: { email: 'xujxu@users.noreply.github.com' },
      account: { provider: 'github', access_token: 'test-token' },
      profile: { email: null },
    } as never);

    expectEqual(
      token.email,
      'x12jiang@outlook.com',
      'uses the verified primary GitHub email when the public profile email is private',
    );
    expectEqual(token.role, 'admin', 'assigns the role from the resolved GitHub email');
  } finally {
    global.fetch = originalFetch;
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  }
}

async function main(): Promise<void> {
  await testSignInCallback();
  await testGitHubPrivateEmailJwt();
}

main().then(() => {
  console.log('auth allowlist tests passed');
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
