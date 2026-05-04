import { getToken } from 'next-auth/jwt';
import { NextRequest } from 'next/server';

/**
 * Shared authentication and permission helpers.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isAdminToken(token: any): boolean {
  if (!token) return false;
  if (token.role === 'admin') return true;
  if (token.sub === 'admin') return true;
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) return false;
  const email = ((token.email as string) || '').toLowerCase();
  return adminEmails.includes(email);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getUserEmail(token: any): string {
  if (!token) return '';
  return ((token.email as string) || '').toLowerCase();
}

/**
 * Check if a token holder can modify a resource owned by `ownerEmail`.
 * Admin can modify anything. Owner can modify their own resources.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canModify(token: any, ownerEmail: string): boolean {
  if (isAdminToken(token)) return true;
  const email = getUserEmail(token);
  return email !== '' && email === ownerEmail.toLowerCase();
}

/**
 * Get the auth token from a Next.js request.
 */
export async function getAuthToken(req: NextRequest) {
  return getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
}

/**
 * Check if a token holder can talk to an agent.
 * Public agents: anyone can talk. Otherwise: admin, owner, or allowlisted user.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canTalkTo(token: any, agentOwner: string, agentId: string, isPublic: boolean, hasAccess: (agentId: string, email: string) => boolean): boolean {
  if (isPublic) return true;
  if (isAdminToken(token)) return true;
  const email = getUserEmail(token);
  if (!email) return false;
  if (email === agentOwner.toLowerCase()) return true;
  return hasAccess(agentId, email);
}
