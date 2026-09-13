# GitHub login allowlist design

## Goal

Restrict who can sign in to Agents Chat with GitHub OAuth. A valid GitHub account alone must not be enough to access the service.

## Scope

This change applies only to the NextAuth GitHub provider. Microsoft Entra ID and local admin username/password login keep their existing behavior.

## Configuration

Add a new environment variable:

```env
GITHUB_ALLOWED_EMAILS=x12jiang@outlook.com
```

The value is a comma-separated list of allowed email addresses. Email matching is case-insensitive and ignores surrounding whitespace.

When GitHub OAuth is configured with `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`, `GITHUB_ALLOWED_EMAILS` is required. The environment example will include `x12jiang@outlook.com` as the default value so first-time deployments can see that this variable must be reviewed and set deliberately.

If `GITHUB_ALLOWED_EMAILS` is empty or missing while GitHub OAuth is enabled, GitHub sign-in is denied. `ADMIN_EMAILS` does not act as a runtime fallback for GitHub login access; it only controls admin role assignment.

## Authentication flow

The GitHub OAuth provider already requests `read:user user:email`. During sign-in, the server will resolve the user's email using the same verified primary GitHub email behavior the app already relies on for JWT role assignment.

The NextAuth `signIn` callback will:

1. Apply the allowlist check only when `account.provider === "github"`.
2. Resolve the GitHub user's email from the OAuth profile/user object, and when needed from `https://api.github.com/user/emails` using the OAuth access token.
3. Build the allowed email set from `GITHUB_ALLOWED_EMAILS`.
4. Allow sign-in only when the resolved email appears in that set.

Denied GitHub users are redirected back to `/login` with the standard NextAuth access denied error. No partial app session is created.

## Components and boundaries

Add small pure helpers in `lib/auth.ts` so the parsing and allowlist decision can be unit tested without going through NextAuth:

- Parse comma-separated email lists.
- Check whether a candidate email is allowed.

The NextAuth route will call these helpers from its `signIn` callback. Existing role assignment remains separate: `ADMIN_EMAILS` continues to grant admin role, while `GITHUB_ALLOWED_EMAILS` controls GitHub login eligibility.

## Error handling

If GitHub email lookup fails and no verified email is available from the OAuth profile/user data, the sign-in is denied. The failure should not be silently converted into an allowed login.

The callback should not throw for normal unauthorized users; it should return `false` so NextAuth handles the access denied login flow.

## Testing

Unit tests will cover the pure allowlist helpers:

- `GITHUB_ALLOWED_EMAILS` allows matching GitHub email.
- Non-matching GitHub email is denied.
- Empty or missing `GITHUB_ALLOWED_EMAILS` denies GitHub login when GitHub OAuth is enabled.
- Matching is case-insensitive and trims whitespace.

E2E coverage will verify login-page behavior around GitHub access denied handling and provider availability without requiring a real GitHub OAuth round trip. Full Playwright E2E will be run before opening the PR.

## Deployment note

Update the environment example/configuration file to include:

```env
# Required when GitHub OAuth is enabled. Only these GitHub account emails can sign in.
# Use a comma-separated list for multiple users.
GITHUB_ALLOWED_EMAILS=x12jiang@outlook.com
```

Deployments that should allow more GitHub users can add additional comma-separated emails.
