import { NextResponse } from 'next/server';

import { createLogger } from '@/lib/logger';
import { checkStorageHealth } from '@/lib/storage/storageHealth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const logger = createLogger('api.health.storage');

type StorageHealthCheck = typeof checkStorageHealth;

export async function handleStorageHealth(
  healthCheck: StorageHealthCheck = checkStorageHealth,
) {
  const result = await healthCheck({ initialize: true });
  if (result.ok) return NextResponse.json({ ok: true });

  logger.error({
    code: result.code,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  }, 'Storage health check failed');
  return NextResponse.json(
    { ok: false, error: 'storage_unavailable' },
    { status: 503 },
  );
}

export async function GET() {
  return handleStorageHealth();
}
