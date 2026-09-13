import {
  getGitHubAllowedEmails,
  isGitHubEmailAllowed,
  parseEmailList,
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

testSignInCallback().then(() => {
  console.log('auth allowlist tests passed');
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
