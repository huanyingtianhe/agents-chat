export type FileReference = { path: string; line?: number };

export function parseFileReference(value: string, explicit = false): FileReference | null {
  if (!value || value.startsWith('//')) return null;
  const suffix = /(?:#L(\d+)(?:-L\d+)?|:(\d+)(?::\d+)?)(?:\s*)$/.exec(value);
  let path = suffix ? value.slice(0, suffix.index) : value;
  try { path = decodeURIComponent(path); } catch { return null; }
  if (/[\x00-\x1f<>?#:]/.test(path.replace(/^[a-z]:[\\/]/i, '')) || /^[\\/]{2}/.test(path)
    || !/(?:^|[\\/])(?:[^\\/]+\.[\w-]+|\.[\w-]+|[A-Z][A-Z\d_-]+)$/.test(path)) return null;
  if (!explicit && !suffix) return null;
  const line = suffix ? Number(suffix[1] || suffix[2]) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1)) return null;
  return { path, line };
}

export function workspaceRelativePath(file: string, cwd?: string): string | null {
  const normalized = file.replaceAll('\\', '/');
  if (normalized.startsWith('//') || normalized.split('/').includes('..')) return null;
  if (!/^(?:\/|[a-z]:)/i.test(normalized)) return normalized;
  if (!cwd) return null;
  const root = cwd.replaceAll('\\', '/').replace(/\/+$/, '') + '/';
  const windows = /^[a-z]:/i.test(root);
  if (!(windows ? normalized.toLowerCase().startsWith(root.toLowerCase()) : normalized.startsWith(root))) return null;
  return normalized.slice(root.length) || null;
}
