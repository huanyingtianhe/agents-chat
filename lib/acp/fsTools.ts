import * as fs from 'fs/promises';
import * as path from 'path';

/* ─────────────── File System Handlers ─────────────── */

export async function handleReadTextFile(params: Record<string, unknown>): Promise<{ content: string }> {
  const filePath = String(params.path ?? '');
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return { content };
  } catch {
    return { content: '' };
  }
}

export async function handleWriteTextFile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const filePath = String(params.path ?? '');
  const content = String(params.content ?? '');
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  } catch { /* ignore */ }
  return {};
}
