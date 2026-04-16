import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

export async function GET(req: NextRequest) {
  const filePath = req.nextUrl.searchParams.get('path');
  if (!filePath) {
    return NextResponse.json({ error: 'missing path param' }, { status: 400 });
  }

  const resolved = path.resolve(filePath);

  // Block obvious sensitive paths
  const blocked = ['/etc/shadow', '/etc/passwd', 'id_rsa', '.env'];
  if (blocked.some(b => resolved.toLowerCase().includes(b))) {
    return NextResponse.json({ error: 'blocked path' }, { status: 403 });
  }

  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: 'file not found' }, { status: 404 });
  }

  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return NextResponse.json({ error: 'not a file' }, { status: 400 });
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME[ext] || 'application/octet-stream';

  const body = fs.readFileSync(resolved);
  return new NextResponse(body, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(body.length),
    },
  });
}
