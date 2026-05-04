import { timingSafeEqual } from 'crypto';
import NextAuth, { type AuthOptions } from 'next-auth';
import AzureADProvider from 'next-auth/providers/azure-ad';
import CredentialsProvider from 'next-auth/providers/credentials';
import { type NextRequest } from 'next/server';

/** Constant-time string comparison to prevent timing attacks. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self so we still spend constant time,
    // but always return false for mismatched lengths.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

const providers: AuthOptions['providers'] = [];

if (process.env.AZURE_AD_CLIENT_ID) {
  providers.push(
    AzureADProvider({
      clientId: process.env.AZURE_AD_CLIENT_ID,
      clientSecret: process.env.AZURE_AD_CLIENT_SECRET || ' ',
      tenantId: process.env.AZURE_AD_TENANT_ID ?? 'common',
      authorization: {
        params: { scope: 'openid profile email User.Read' },
      },
      checks: ['pkce'],
      client: { token_endpoint_auth_method: 'none' },
    }),
  );
}

providers.push(
  CredentialsProvider({
    id: 'admin-login',
    name: 'Admin',
    credentials: {
      username: { label: 'Username', type: 'text' },
      password: { label: 'Password', type: 'password' },
    },
    async authorize(credentials) {
      const adminUser = process.env.ADMIN_USERNAME;
      const adminPass = process.env.ADMIN_PASSWORD;
      // Disable credentials login when either env var is missing
      if (!adminUser || !adminPass) return null;
      if (
        credentials?.username &&
        credentials?.password &&
        safeEqual(credentials.username, adminUser) &&
        safeEqual(credentials.password, adminPass)
      ) {
        return { id: 'admin', name: 'Admin', email: 'admin@local', role: 'admin' };
      }
      return null;
    },
  }),
);

export const authOptions: AuthOptions = {
  debug: true,
  providers,
  pages: { signIn: '/login' },
  session: { strategy: 'jwt' },
  cookies: {
    csrfToken: {
      name: 'next-auth.csrf-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: true,
      },
    },
    callbackUrl: {
      name: 'next-auth.callback-url',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: true,
      },
    },
    state: {
      name: 'next-auth.state',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: true,
      },
    },
    pkceCodeVerifier: {
      name: 'next-auth.pkce.code_verifier',
      options: {
        httpOnly: true,
        sameSite: 'none',
        path: '/',
        secure: true,
      },
    },
    sessionToken: {
      name: 'next-auth.session-token',
      options: {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: true,
      },
    },
  },
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Credentials login with role=admin → always admin
        if ((user as any).role === 'admin') {
          token.role = 'admin';
        } else {
          // Azure AD / OAuth users: check ADMIN_EMAILS env var
          const adminEmails = (process.env.ADMIN_EMAILS || '')
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean);
          const userEmail = (user.email || '').toLowerCase();
          token.role = adminEmails.includes(userEmail) ? 'admin' : 'user';
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).role = token.role ?? 'user';
      }
      return session;
    },
  },
};

const authHandler = NextAuth(authOptions);

// Detect real host from proxy headers and set NEXTAUTH_URL per-request
function applyHost(req: NextRequest) {
  const proto = req.headers.get('x-forwarded-proto') || 'http';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || 'localhost:3000';
  process.env.NEXTAUTH_URL = `${proto}://${host}`;
}

export async function GET(req: NextRequest, ctx: any) {
  applyHost(req);
  return authHandler(req, ctx);
}

export async function POST(req: NextRequest, ctx: any) {
  applyHost(req);
  return authHandler(req, ctx);
}
