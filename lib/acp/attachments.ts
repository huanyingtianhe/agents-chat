import type { AcpPromptPart, PromptAttachment } from './types';

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_INLINE_ATTACHMENT_CHARS = 120_000;

export class AttachmentValidationError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AttachmentValidationError';
    this.status = status;
  }
}

export function formatAttachmentBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function isAllowedAttachmentMimeType(mimeType: string): boolean {
  const allowedAttachmentMimeTypes = new Set([
    'application/pdf',
    'application/json',
    'application/x-pem-file',
    'application/x-yaml',
    'application/javascript',
    'application/typescript',
  ]);
  return mimeType.startsWith('image/') || mimeType.startsWith('text/') || allowedAttachmentMimeTypes.has(mimeType);
}

export const ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  bash: 'text/x-shellscript',
  bat: 'text/x-bat',
  c: 'text/x-c',
  cc: 'text/x-c++',
  cer: 'application/x-pem-file',
  cfg: 'text/plain',
  clj: 'text/x-clojure',
  cljs: 'text/x-clojure',
  cmake: 'text/x-cmake',
  cmd: 'text/x-bat',
  conf: 'text/plain',
  cpp: 'text/x-c++',
  crt: 'application/x-pem-file',
  cshtml: 'text/html',
  csproj: 'text/xml',
  cs: 'text/x-csharp',
  css: 'text/css',
  csv: 'text/csv',
  cjs: 'text/javascript',
  cts: 'text/typescript',
  cxx: 'text/x-c++',
  dart: 'text/x-dart',
  diff: 'text/x-diff',
  dockerfile: 'text/x-dockerfile',
  editorconfig: 'text/plain',
  env: 'text/plain',
  erl: 'text/x-erlang',
  ex: 'text/x-elixir',
  exs: 'text/x-elixir',
  fish: 'text/x-shellscript',
  fs: 'text/x-fsharp',
  fsproj: 'text/xml',
  fsi: 'text/x-fsharp',
  fsx: 'text/x-fsharp',
  gitignore: 'text/plain',
  go: 'text/x-go',
  gql: 'text/graphql',
  gradle: 'text/x-gradle',
  graphql: 'text/graphql',
  h: 'text/x-c',
  hpp: 'text/x-c++',
  hrl: 'text/x-erlang',
  htm: 'text/html',
  html: 'text/html',
  hxx: 'text/x-c++',
  ini: 'text/plain',
  java: 'text/x-java-source',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  jsx: 'text/javascript',
  key: 'application/x-pem-file',
  kt: 'text/x-kotlin',
  kts: 'text/x-kotlin',
  less: 'text/css',
  lock: 'text/plain',
  log: 'text/plain',
  lua: 'text/x-lua',
  m: 'text/x-objective-c',
  md: 'text/markdown',
  mm: 'text/x-objective-c++',
  mjs: 'text/javascript',
  mts: 'text/typescript',
  patch: 'text/x-diff',
  pem: 'application/x-pem-file',
  php: 'text/x-php',
  pl: 'text/x-perl',
  pm: 'text/x-perl',
  pdf: 'application/pdf',
  png: 'image/png',
  props: 'text/xml',
  properties: 'text/plain',
  proto: 'text/x-protobuf',
  ps1: 'text/x-powershell',
  psd1: 'text/x-powershell',
  psm1: 'text/x-powershell',
  pub: 'application/x-pem-file',
  py: 'text/x-python',
  r: 'text/x-r',
  razor: 'text/html',
  rb: 'text/x-ruby',
  rs: 'text/x-rustsrc',
  sass: 'text/css',
  scala: 'text/x-scala',
  scss: 'text/css',
  sh: 'text/x-shellscript',
  sln: 'text/plain',
  sql: 'text/x-sql',
  svelte: 'text/html',
  svg: 'image/svg+xml',
  swift: 'text/x-swift',
  targets: 'text/xml',
  toml: 'text/toml',
  ts: 'text/typescript',
  tsbuildinfo: 'application/json',
  tsx: 'text/typescript',
  txt: 'text/plain',
  vb: 'text/x-vb',
  vbproj: 'text/xml',
  vue: 'text/html',
  xaml: 'text/xml',
  xml: 'text/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  zsh: 'text/x-shellscript',
};

export const ATTACHMENT_MIME_BY_BASENAME: Record<string, string> = {
  '.babelrc': 'application/json',
  '.dockerignore': 'text/plain',
  '.editorconfig': 'text/plain',
  '.env': 'text/plain',
  '.env.development': 'text/plain',
  '.env.example': 'text/plain',
  '.env.local': 'text/plain',
  '.env.production': 'text/plain',
  '.env.test': 'text/plain',
  '.eslintignore': 'text/plain',
  '.eslintrc': 'application/json',
  '.gitattributes': 'text/plain',
  '.gitignore': 'text/plain',
  '.npmrc': 'text/plain',
  '.prettierignore': 'text/plain',
  '.prettierrc': 'application/json',
  '.yarnrc': 'text/plain',
  dockerfile: 'text/x-dockerfile',
  gemfile: 'text/x-ruby',
  justfile: 'text/plain',
  makefile: 'text/x-makefile',
  procfile: 'text/plain',
  rakefile: 'text/x-ruby',
};

export function getAttachmentFileKey(name: string): string {
  return name.trim().split(/[\\/]/).pop()?.toLowerCase() || '';
}

export function inferAttachmentMimeType(name: string, mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized && normalized !== 'application/octet-stream') return normalized;
  const fileKey = getAttachmentFileKey(name);
  const exact = ATTACHMENT_MIME_BY_BASENAME[fileKey] || ATTACHMENT_MIME_BY_EXTENSION[fileKey];
  if (exact) return exact;
  const extension = fileKey.includes('.') ? fileKey.split('.').pop()?.trim().toLowerCase() : '';
  return (extension && ATTACHMENT_MIME_BY_EXTENSION[extension]) || normalized || 'application/octet-stream';
}

export function rewriteDataUrlMimeType(dataUrl: string, mimeType: string): string {
  return dataUrl.replace(/^data:[^;,]*;base64,/, `data:${mimeType};base64,`);
}

export function splitDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]*);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2].replace(/[\r\n]/g, '') };
}

export function normalizePromptAttachments(raw: unknown): PromptAttachment[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new AttachmentValidationError('invalid_attachments');
  if (raw.length > MAX_ATTACHMENTS) throw new AttachmentValidationError('too_many_attachments');

  let totalSize = 0;
  return raw.map((item) => {
    if (!item || typeof item !== 'object') throw new AttachmentValidationError('invalid_attachments');
    const value = item as Record<string, unknown>;
    const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 255) : '';
    const rawMimeType = typeof value.mimeType === 'string' && value.mimeType.trim() ? value.mimeType.trim().slice(0, 120) : 'application/octet-stream';
    const mimeType = inferAttachmentMimeType(name, rawMimeType);
    const size = typeof value.size === 'number' ? value.size : Number(value.size);
    const dataUrl = typeof value.dataUrl === 'string' ? value.dataUrl : '';
    if (!name || !Number.isFinite(size) || size < 0 || !dataUrl) throw new AttachmentValidationError('invalid_attachments');
    if (size > MAX_ATTACHMENT_BYTES) throw new AttachmentValidationError('attachment_too_large');
    totalSize += size;
    if (totalSize > MAX_TOTAL_ATTACHMENT_BYTES) throw new AttachmentValidationError('attachments_too_large');
    const parsed = splitDataUrl(dataUrl);
    const parsedMimeType = parsed ? inferAttachmentMimeType(name, parsed.mimeType) : '';
    if (!parsed || parsedMimeType !== mimeType || !isAllowedAttachmentMimeType(mimeType)) throw new AttachmentValidationError('invalid_attachments');
    const decodedBytes = Buffer.byteLength(parsed.data, 'base64');
    if (decodedBytes > MAX_ATTACHMENT_BYTES || Math.abs(decodedBytes - size) > Math.max(8, Math.ceil(size * 0.05))) {
      throw new AttachmentValidationError('invalid_attachments');
    }
    const kind = value.kind === 'image' || mimeType.startsWith('image/') ? 'image' : 'file';
    return {
      id: typeof value.id === 'string' ? value.id : undefined,
      name,
      mimeType,
      size,
      dataUrl: parsed.mimeType === mimeType ? dataUrl : rewriteDataUrlMimeType(dataUrl, mimeType),
      kind,
    };
  });
}

export function buildAttachmentSummary(attachments: PromptAttachment[]): string {
  if (attachments.length === 0) return '';
  return attachments.map((a) => `- ${a.name} (${a.mimeType}, ${formatAttachmentBytes(a.size)})`).join('\n');
}

export function isInlineTextAttachmentMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || [
    'application/json',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
  ].includes(mimeType);
}

export function buildAttachmentTextBlocks(attachments: PromptAttachment[]): string {
  const blocks: string[] = [];
  for (const attachment of attachments) {
    if (attachment.kind === 'image' || attachment.mimeType.startsWith('image/')) continue;
    if (!isInlineTextAttachmentMimeType(attachment.mimeType)) continue;
    const parsed = splitDataUrl(attachment.dataUrl);
    if (!parsed) continue;
    const text = Buffer.from(parsed.data, 'base64').toString('utf8');
    const clipped = text.length > MAX_INLINE_ATTACHMENT_CHARS
      ? `${text.slice(0, MAX_INLINE_ATTACHMENT_CHARS)}\n\n[Attachment truncated after ${MAX_INLINE_ATTACHMENT_CHARS} characters]`
      : text;
    blocks.push(`File: ${attachment.name} (${attachment.mimeType})\n\`\`\`\n${clipped}\n\`\`\``);
  }
  return blocks.length ? `Attached file content:\n\n${blocks.join('\n\n')}` : '';
}

export function buildPromptParts(text: string, attachments: PromptAttachment[] = []): AcpPromptPart[] {
  const parts: AcpPromptPart[] = [];
  const trimmedText = text.trim();
  const summary = buildAttachmentSummary(attachments);
  const textBlocks = buildAttachmentTextBlocks(attachments);
  const textPart = [
    trimmedText,
    summary ? `Attached file(s):\n${summary}` : '',
    textBlocks,
  ].filter(Boolean).join('\n\n') || 'Please review the attached file(s).';
  parts.push({ type: 'text', text: textPart });
  for (const attachment of attachments) {
    const parsed = splitDataUrl(attachment.dataUrl);
    if (!parsed) continue;
    if ((attachment.kind || (attachment.mimeType.startsWith('image/') ? 'image' : 'file')) === 'image') {
      parts.push({ type: 'image', mimeType: attachment.mimeType, data: parsed.data, name: attachment.name });
    }
  }
  return parts;
}
