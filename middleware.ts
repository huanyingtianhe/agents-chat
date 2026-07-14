import { getToken } from 'next-auth/jwt';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Derive the public-facing origin from reverse-proxy headers.
 * Next.js middleware may see `request.url` as `https://localhost:3010/...`
 * when behind nginx, so we reconstruct the correct origin from forwarded
 * headers to build proper redirect URLs.
 */
function getPublicUrl(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  if (host) {
    const pathname = request.nextUrl.pathname;
    const search = request.nextUrl.search;
    return `${proto}://${host}${pathname}${search}`;
  }
  return request.url;
}

export async function middleware(request: NextRequest) {
  const token = await getToken({ req: request, cookieName: 'next-auth.session-token' });
  if (!token) {
    // For API routes, return 401 JSON instead of redirecting to login page.
    // This prevents the client from receiving HTML when it expects JSON.
    if (request.nextUrl.pathname.startsWith('/api/')) {
      return NextResponse.json(
        { ok: false, error: 'unauthenticated', message: 'Session expired. Please sign in again.' },
        { status: 401 },
      );
    }
    const publicUrl = getPublicUrl(request);
    const loginUrl = new URL('/login', publicUrl);
    loginUrl.searchParams.set('callbackUrl', publicUrl);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!login|api/auth|_next|favicon|opengraph-image|twitter-image|.*\\.svg$|.*\\.png$|.*\\.ico$).*)',
  ],
};
