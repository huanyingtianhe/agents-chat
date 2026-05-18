import { NextResponse } from 'next/server';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { renderSetupNodeScript } from '../../../../lib/setupNodeTemplate.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SETUP_FILES_DIR = path.join(process.cwd(), 'setup-files');
const execFileAsync = promisify(execFile);

export async function GET() {
  try {
    // Verify setup files exist
    const ps1Path = path.join(SETUP_FILES_DIR, 'setup-node.ps1');
    const jsPath = path.join(SETUP_FILES_DIR, 'relay-listener.js');

    await Promise.all([
      fs.access(ps1Path),
      fs.access(jsPath),
    ]);

    // Create zip in a request-scoped temp directory
    const zipName = 'copilot-node-setup.zip';
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-setup-zip-'));
    const zipPath = path.join(tempDir, zipName);
    const stagedPs1Path = path.join(tempDir, 'setup-node.ps1');
    const compressScriptPath = path.join(tempDir, 'compress-setup-zip.ps1');

    const zipBuffer = await (async () => {
      try {
        const setupNodeScript = await fs.readFile(ps1Path, 'utf-8');

        // Use PowerShell Compress-Archive (available on Windows)
        await fs.writeFile(stagedPs1Path, renderSetupNodeScript(setupNodeScript), 'utf-8');
        await fs.writeFile(
          compressScriptPath,
          [
            'param([string]$SetupScript, [string]$RelayListener, [string]$ZipPath)',
            'Compress-Archive -LiteralPath @($SetupScript, $RelayListener) -DestinationPath $ZipPath -Force',
          ].join('\n'),
          'utf-8'
        );
        await execFileAsync(
          'powershell',
          [
            '-NoProfile',
            '-File',
            compressScriptPath,
            stagedPs1Path,
            jsPath,
            zipPath,
          ],
          { timeout: 10_000, windowsHide: true }
        );

        return await fs.readFile(zipPath);
      } finally {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupErr) {
          console.warn('[Setup ZIP] Failed to clean up temporary setup files', cleanupErr);
        }
      }
    })();

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
