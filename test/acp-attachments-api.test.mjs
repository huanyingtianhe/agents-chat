import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');
const attachmentSource = readFileSync(new URL('../lib/acp/attachments.ts', import.meta.url), 'utf8');
const combinedSource = `${routeSource}\n${attachmentSource}`;

function expectIncludes(needle, message, source = combinedSource) {
  assert.ok(source.includes(needle), message || `Expected source to include ${needle}`);
}

expectIncludes('const MAX_ATTACHMENTS = 8;', 'attachment count limit should be defined', attachmentSource);
expectIncludes('const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;', 'per-file attachment limit should be defined', attachmentSource);
expectIncludes('const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;', 'total attachment limit should be defined', attachmentSource);
expectIncludes('function normalizePromptAttachments(raw: unknown): PromptAttachment[]', 'attachments should be normalized through a helper', attachmentSource);
expectIncludes('function inferAttachmentMimeType(name: string, mimeType: string): string', 'generic attachment MIME types should be inferred from filename', attachmentSource);
expectIncludes("cs: 'text/x-csharp'", 'C# attachments should be normalized from extension', attachmentSource);
expectIncludes("cpp: 'text/x-c++'", 'C++ attachments should be normalized from extension', attachmentSource);
expectIncludes("java: 'text/x-java-source'", 'Java attachments should be normalized from extension', attachmentSource);
expectIncludes("go: 'text/x-go'", 'Go attachments should be normalized from extension', attachmentSource);
expectIncludes("mjs: 'text/javascript'", 'MJS attachments should be normalized from extension', attachmentSource);
expectIncludes("svg: 'image/svg+xml'", 'SVG attachments should be normalized from extension', attachmentSource);
expectIncludes("pem: 'application/x-pem-file'", 'PEM attachments should be normalized from extension', attachmentSource);
expectIncludes("'.env.local': 'text/plain'", 'dot-env attachments should be normalized by basename', attachmentSource);
expectIncludes("ps1: 'text/x-powershell'", 'PowerShell attachments should be normalized from extension', attachmentSource);
expectIncludes("'text/x-powershell'", 'PowerShell attachments should be allowed by backend validation', attachmentSource);
expectIncludes("mimeType.startsWith('text/')", 'text-based code attachments should be allowed by backend validation', attachmentSource);
expectIncludes('const parsedMimeType = parsed ? inferAttachmentMimeType(name, parsed.mimeType) :', 'data URL MIME type should be normalized before validation', attachmentSource);
expectIncludes("throw new AttachmentValidationError('invalid_attachments')", 'invalid attachments should return explicit validation errors', attachmentSource);
expectIncludes("throw new AttachmentValidationError('attachment_too_large')", 'oversized attachments should return explicit validation errors', attachmentSource);
expectIncludes("throw new AttachmentValidationError('too_many_attachments')", 'too many attachments should return explicit validation errors', attachmentSource);
expectIncludes('function buildPromptParts(text: string, attachments: PromptAttachment[] = [])', 'ACP prompt parts should be built through a helper', attachmentSource);
expectIncludes("type: 'image'", 'image prompt parts should be generated', attachmentSource);
expectIncludes('function buildAttachmentTextBlocks(attachments: PromptAttachment[]): string', 'text file attachments should be injected into the text prompt', attachmentSource);
expectIncludes('Attached file content:\\n\\n${blocks.join', 'file prompt text should include decoded attachment content', attachmentSource);
expectIncludes('Attached file(s):\\n${summary}', 'prompt text should include an attachment summary fallback', attachmentSource);
expectIncludes("if (!parsed || parsedMimeType !== mimeType || !isAllowedAttachmentMimeType(mimeType))", 'unsupported attachment MIME types should be rejected', attachmentSource);
expectIncludes('attachments = normalizePromptAttachments(body?.attachments)', 'send action should read body.attachments', routeSource);
expectIncludes('if (!text && attachments.length === 0)', 'attachment-only sends should be allowed while empty sends are rejected', routeSource);
expectIncludes('sendPrompt(proc, sess, agentId, text, isAdmin, userId, chatHistory, chatId, messageId, attachments, requestedModelId)', 'sendPrompt should receive normalized attachments and requested model ID', routeSource);
expectIncludes('prompt: promptParts', 'initial session/prompt should use buildPromptParts output', routeSource);
expectIncludes('prompt: buildPromptParts(retryText, attachments)', 'retry session/prompt should use buildPromptParts output', routeSource);

const sendPromptSignature = routeSource.match(/function sendPrompt\([^)]*attachments: PromptAttachment\[\] = \[\][^)]*\)/s);
assert.ok(sendPromptSignature, 'sendPrompt signature should accept attachments');

const invalidReturn = /catch \(err\) \{[\s\S]*AttachmentValidationError[\s\S]*NextResponse\.json\(\{ ok: false, error: err\.message \}, \{ status: err\.status \}\)/.test(routeSource);
assert.ok(invalidReturn, 'attachment validation failures should return explicit 400-style JSON errors');

console.log('acp attachment checks passed');
