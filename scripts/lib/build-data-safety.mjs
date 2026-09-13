import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export function isRuntimeDataArtifact(relativePath) {
  const normalized = relativePath.split(path.sep).join('/');
  return normalized === '.data'
    || normalized.startsWith('.data/')
    || /^\.agents-chat-storage\.json(?:\.|$)/.test(normalized)
    || /^\.agents-chat-operation\.json(?:\.|$)/.test(normalized);
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

export function sanitizeBuildOutput(projectRoot) {
  const nextRoot = path.join(projectRoot, '.next');
  const standaloneRoot = path.join(nextRoot, 'standalone');

  for (const manifestPath of walkFiles(nextRoot).filter((filePath) =>
    filePath.endsWith('.nft.json'))) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const files = (manifest.files ?? []).filter((tracedFile) => {
      const resolved = path.resolve(path.dirname(manifestPath), tracedFile);
      return !isRuntimeDataArtifact(path.relative(projectRoot, resolved))
        && !isRuntimeDataArtifact(path.relative(standaloneRoot, resolved));
    });
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, files }));
  }

  rmSync(path.join(standaloneRoot, '.data'), { recursive: true, force: true });
  if (existsSync(standaloneRoot)) {
    for (const entry of readdirSync(standaloneRoot)) {
      if (isRuntimeDataArtifact(entry)) {
        rmSync(path.join(standaloneRoot, entry), { recursive: true, force: true });
      }
    }
  }
}
