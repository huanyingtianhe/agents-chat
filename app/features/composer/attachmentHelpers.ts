import type { ChatAttachment } from './attachmentTypes';

export const MAX_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
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

const ATTACHMENT_MIME_BY_BASENAME: Record<string, string> = {
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

export const ATTACHMENT_ACCEPT = [
  'image/*',
  ...Object.keys(ATTACHMENT_MIME_BY_EXTENSION).map((extension) => `.${extension}`),
  ...Object.keys(ATTACHMENT_MIME_BY_BASENAME),
].join(',');

export function formatBytes(bytes: number): string {
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

export function getAttachmentKind(mimeType: string): ChatAttachment['kind'] {
  return mimeType.startsWith('image/') ? 'image' : 'file';
}

export function getAttachmentFileKey(name: string): string {
  return name.trim().split(/[\\/]/).pop()?.toLowerCase() || '';
}

export function getAttachmentMimeType(name: string, providedMimeType: string): string {
  const normalized = providedMimeType.trim().toLowerCase();
  if (normalized && normalized !== 'application/octet-stream') return normalized;
  const fileKey = getAttachmentFileKey(name);
  const exact = ATTACHMENT_MIME_BY_BASENAME[fileKey] || ATTACHMENT_MIME_BY_EXTENSION[fileKey];
  if (exact) return exact;
  const extension = fileKey.includes('.') ? fileKey.split('.').pop()?.trim().toLowerCase() : '';
  return (extension && ATTACHMENT_MIME_BY_EXTENSION[extension]) || normalized || 'application/octet-stream';
}

export function withAttachmentDataUrlMimeType(dataUrl: string, mimeType: string): string {
  return dataUrl.replace(/^data:[^;,]*;base64,/, `data:${mimeType};base64,`);
}

export function getAttachmentTypeLabel(attachment: ChatAttachment): string {
  const mimeType = attachment.mimeType.trim().toLowerCase();
  if (attachment.kind === 'image') {
    const imageType = mimeType.startsWith('image/') ? mimeType.slice('image/'.length).split(/[;+]/)[0] : '';
    return imageType ? `${imageType.toUpperCase()} image` : 'Image';
  }

  const extension = attachment.name.includes('.') ? attachment.name.split('.').pop()?.toUpperCase() : '';
  if (!mimeType || mimeType === 'application/octet-stream') return extension ? `${extension} file` : 'File';
  if (mimeType === 'application/pdf') return 'PDF';
  if (extension && Object.values(ATTACHMENT_MIME_BY_EXTENSION).includes(mimeType)) return `${extension} file`;
  if (mimeType === 'text/plain') return 'Text file';
  return mimeType;
}

export function getAttachmentIconLabel(attachment: ChatAttachment): string {
  const extension = attachment.name.includes('.') ? attachment.name.split('.').pop()?.trim().toLowerCase() : '';
  if (!extension) return 'FILE';
  const aliases: Record<string, string> = {
    jpeg: 'JPG',
    markdown: 'MD',
    typescript: 'TS',
    javascript: 'JS',
  };
  return (aliases[extension] || extension.toUpperCase()).slice(0, 3);
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function filesToAttachments(files: File[], existing: ChatAttachment[]): Promise<{ attachments: ChatAttachment[]; error?: string }> {
  if (files.length === 0) return { attachments: [] };
  if (existing.length + files.length > MAX_ATTACHMENTS) return { attachments: [], error: `You can attach up to ${MAX_ATTACHMENTS} files.` };
  const existingTotal = existing.reduce((sum, attachment) => sum + attachment.size, 0);
  let newTotal = 0;
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) return { attachments: [], error: `${file.name || 'File'} is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.` };
    newTotal += file.size;
  }
  if (existingTotal + newTotal > MAX_TOTAL_ATTACHMENT_BYTES) return { attachments: [], error: `Attachments can total up to ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}.` };

  const attachments = await Promise.all(files.map(async (file) => {
    const name = file.name || 'clipboard-file';
    const mimeType = getAttachmentMimeType(name, file.type || 'application/octet-stream');
    const dataUrl = withAttachmentDataUrlMimeType(await readFileAsDataUrl(file), mimeType);
    return {
      id: `attachment-${makeId()}`,
      name,
      mimeType,
      size: file.size,
      dataUrl,
      kind: getAttachmentKind(mimeType),
    } satisfies ChatAttachment;
  }));
  return { attachments };
}

export function getAttachmentSummaryText(attachments: ChatAttachment[] = []): string {
  if (attachments.length === 0) return '';
  return `Attached file(s):\n${attachments.map((a) => `- ${a.name} (${a.mimeType}, ${formatBytes(a.size)})`).join('\n')}`;
}
