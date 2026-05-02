import { NextResponse } from 'next/server';
import * as path from 'path';
import * as fs from 'fs/promises';
import { execSync } from 'child_process';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SETUP_FILES_DIR = path.join(process.cwd(), 'setup-files');

export async function GET() {
  try {
    // Verify setup files exist
    const ps1Path = path.join(SETUP_FILES_DIR, 'setup-node.ps1');
    const jsPath = path.join(SETUP_FILES_DIR, 'relay-listener.js');

    await Promise.all([
      fs.access(ps1Path),
      fs.access(jsPath),
    ]);

    // Create zip in temp directory
    const zipName = 'copilot-node-setup.zip';
    const tempDir = path.join(process.env.TEMP || '/tmp', 'node-setup-zip');
    await fs.mkdir(tempDir, { recursive: true });
    const zipPath = path.join(tempDir, zipName);

    // Use PowerShell Compress-Archive (available on Windows)
    try { await fs.unlink(zipPath); } catch { /* ignore */ }
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${ps1Path}','${jsPath}' -DestinationPath '${zipPath}' -Force"`,
      { timeout: 10_000, windowsHide: true }
    );

    const zipBuffer = await fs.readFile(zipPath);

    // Cleanup temp zip
    try { await fs.unlink(zipPath); } catch { /* ignore */ }

    return new NextResponse(zipBuffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}"`,
        'Content-Length': String(zipBuffer.length),
      },
    });
  } catch (err) {
    console.error('[Setup ZIP]', err);
    return NextResponse.json(
      { ok: false, error: 'Failed to generate setup zip: ' + String(err) },
      { status: 500 }
    );
  }
}
