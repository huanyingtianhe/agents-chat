import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'fs/promises';
import * as path from 'path';
import { existsSync, statSync, realpathSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getAuthToken, canTalkTo } from '@/lib/auth';
import * as configStore from '@/lib/configStore';

const execFileAsync = promisify(execFile);

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage',
  '.data', '.cache', '__pycache__', '.venv', 'venv', 'vendor',
]);

const MAX_DEPTH = 8;

// Binary/non-text extensions to exclude from file listing
const SKIP_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm', '.flac',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pyc', '.pyo', '.class', '.jar',
  '.db', '.sqlite', '.sqlite3',
  '.lock', '.map',
]);

/**
 * Resolve agent cwd and validate that a relative path is safely contained within it.
 * Returns the resolved absolute target path or null if invalid.
 */
function resolveAndValidate(agentCwd: string, relativePath: string): string | null {
  // Reject absolute, drive-qualified, and UNC paths
  if (path.isAbsolute(relativePath)) return null;
  if (/^[a-zA-Z]:/.test(relativePath)) return null;
  if (relativePath.startsWith('\\\\') || relativePath.startsWith('//')) return null;

  // Join and resolve
  const target = path.resolve(agentCwd, relativePath);

  // Verify containment using path.relative — must not start with '..'
  const rel = path.relative(agentCwd, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  return target;
}

/**
 * Recursively collect text files under a directory.
 */
async function collectFiles(
  dir: string,
  baseCwd: string,
  depth: number,
  result: { path: string; name: string; mtime: string }[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(path.join(dir, entry.name), baseCwd, depth + 1, result);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXTENSIONS.has(ext)) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(fullPath);
        result.push({
          path: path.relative(baseCwd, fullPath).replace(/\\/g, '/'),
          name: entry.name,
          mtime: stat.mtime.toISOString(),
        });
      } catch { /* skip inaccessible */ }
    }
  }
}

/**
 * GET /api/markdown?agentId=X          → list .md files
 * GET /api/markdown?agentId=X&path=Y   → read a specific .md file
 */
export async function GET(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const agentId = req.nextUrl.searchParams.get('agentId');
  if (!agentId) {
    return NextResponse.json({ error: 'missing agentId' }, { status: 400 });
  }

  const agent = configStore.getAgentById(agentId);
  if (!agent) {
    return NextResponse.json({ error: 'agent not found' }, { status: 404 });
  }

  // Permission check: same as agent access (public, admin, owner, or allowlisted)
  if (!canTalkTo(token, agent.owner || '', agentId, !!agent.public, configStore.hasAgentAccess)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const agentCwd = agent.cwd;
  if (!agentCwd || !existsSync(agentCwd)) {
    return NextResponse.json({ error: 'agent cwd not found' }, { status: 404 });
  }

  const filePath = req.nextUrl.searchParams.get('path');
  const diffOnly = req.nextUrl.searchParams.get('diff') === 'true';

  if (!filePath) {
    // List files
    if (diffOnly) {
      // Get git changed files (staged + unstaged + untracked)
      try {
        const [diffResult, untrackedResult] = await Promise.all([
          execFileAsync('git', ['diff', '--name-only', 'HEAD'], { cwd: agentCwd }).catch(() => ({ stdout: '' })),
          execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: agentCwd }).catch(() => ({ stdout: '' })),
        ]);
        const changedPaths = new Set(
          [...diffResult.stdout.split('\n'), ...untrackedResult.stdout.split('\n')]
            .map(l => l.trim())
            .filter(l => l.length > 0)
        );
        const files: { path: string; name: string; mtime: string }[] = [];
        for (const relPath of changedPaths) {
          const ext = path.extname(relPath).toLowerCase();
          if (SKIP_EXTENSIONS.has(ext)) continue;
          const fullPath = path.resolve(agentCwd, relPath);
          if (!existsSync(fullPath)) continue;
          try {
            const stat = await fs.stat(fullPath);
            if (!stat.isFile()) continue;
            files.push({
              path: relPath.replace(/\\/g, '/'),
              name: path.basename(relPath),
              mtime: stat.mtime.toISOString(),
            });
          } catch { /* skip */ }
        }
        files.sort((a, b) => a.path.localeCompare(b.path));
        return NextResponse.json({ files });
      } catch {
        return NextResponse.json({ error: 'git diff failed — is this a git repository?' }, { status: 400 });
      }
    }

    const files: { path: string; name: string; mtime: string }[] = [];
    await collectFiles(agentCwd, agentCwd, 0, files);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return NextResponse.json({ files });
  }

  // Read a specific file
  const target = resolveAndValidate(agentCwd, filePath);
  if (!target) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  if (!existsSync(target)) {
    return NextResponse.json({ error: 'file not found' }, { status: 404 });
  }

  // Verify real path is still within cwd (symlink protection)
  try {
    const realTarget = realpathSync(target);
    const realCwd = realpathSync(agentCwd);
    const rel = path.relative(realCwd, realTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return NextResponse.json({ error: 'path escapes agent directory' }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: 'path validation failed' }, { status: 400 });
  }

  try {
    const content = await fs.readFile(target, 'utf-8');
    const stat = statSync(target);
    const ext = path.extname(target).toLowerCase();
    const kind = ext === '.html' || ext === '.htm' ? 'html' : ext === '.md' ? 'markdown' : 'text';
    return NextResponse.json({
      path: filePath,
      content,
      kind,
      mtime: stat.mtime.toISOString(),
    });
  } catch {
    return NextResponse.json({ error: 'failed to read file' }, { status: 500 });
  }
}

/**
 * POST /api/markdown  { agentId, path, content, mtime? }
 * Save/update a markdown file. Optional mtime for optimistic concurrency.
 */
export async function POST(req: NextRequest) {
  const token = await getAuthToken(req);
  if (!token) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: { agentId?: string; path?: string; content?: string; mtime?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  }

  const { agentId, path: filePath, content } = body;
  if (!agentId || !filePath || content === undefined) {
    return NextResponse.json({ error: 'missing agentId, path, or content' }, { status: 400 });
  }

  const agent = configStore.getAgentById(agentId);
  if (!agent) {
    return NextResponse.json({ error: 'agent not found' }, { status: 404 });
  }

  // Permission check: same as agent access
  if (!canTalkTo(token, agent.owner || '', agentId, !!agent.public, configStore.hasAgentAccess)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const agentCwd = agent.cwd;
  if (!agentCwd || !existsSync(agentCwd)) {
    return NextResponse.json({ error: 'agent cwd not found' }, { status: 404 });
  }

  const target = resolveAndValidate(agentCwd, filePath);
  if (!target) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  // Optimistic concurrency: if caller provided mtime, check it matches
  if (body.mtime && existsSync(target)) {
    try {
      const stat = statSync(target);
      if (stat.mtime.toISOString() !== body.mtime) {
        const serverContent = await fs.readFile(target, 'utf-8');
        return NextResponse.json({
          error: 'conflict',
          message: 'File was modified externally. Choose how to resolve the conflict.',
          serverContent,
          serverMtime: stat.mtime.toISOString(),
        }, { status: 409 });
      }
    } catch { /* proceed */ }
  }

  // Verify parent directory real path is within cwd
  const parentDir = path.dirname(target);
  try {
    await fs.mkdir(parentDir, { recursive: true });
    const realParent = realpathSync(parentDir);
    const realCwd = realpathSync(agentCwd);
    const rel = path.relative(realCwd, realParent);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return NextResponse.json({ error: 'path escapes agent directory' }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: 'path validation failed' }, { status: 400 });
  }

  try {
    await fs.writeFile(target, content, 'utf-8');
    const stat = statSync(target);
    return NextResponse.json({
      ok: true,
      path: filePath,
      mtime: stat.mtime.toISOString(),
    });
  } catch {
    return NextResponse.json({ error: 'failed to write file' }, { status: 500 });
  }
}
