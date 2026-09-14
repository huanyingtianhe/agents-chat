import assert from 'node:assert/strict';
import test from 'node:test';

import { NextRequest } from 'next/server';

import { handleStorageHealth } from '../app/api/health/storage/route';
import { middleware } from '../middleware';

test('unauthenticated storage health responses reach the route while other APIs remain gated', async () => {
  for (const result of [
    { ok: true } as const,
    { ok: false, code: 'DATABASE_BUSY' } as const,
  ]) {
    const request = new NextRequest('http://localhost/api/health/storage');
    const middlewareResponse = await middleware(request);
    assert.equal(middlewareResponse.status, 200);
    assert.equal(middlewareResponse.headers.get('x-middleware-next'), '1');

    const routeResponse = await handleStorageHealth(async () => result);
    assert.equal(routeResponse.status, result.ok ? 200 : 503);
  }

  for (const pathname of ['/api/chats', '/api/health', '/api/health/storage/details']) {
    const response = await middleware(new NextRequest(`http://localhost${pathname}`));
    assert.equal(response.status, 401, `${pathname} must remain protected`);
    assert.deepEqual(await response.json(), {
      ok: false,
      error: 'unauthenticated',
      message: 'Session expired. Please sign in again.',
    });
  }
});
