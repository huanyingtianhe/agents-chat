import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routeSource = readFileSync(new URL('../app/api/acp/route.ts', import.meta.url), 'utf8');

function expectIncludes(needle, message) {
  assert.ok(routeSource.includes(needle), message || `Expected route.ts to include ${needle}`);
}

expectIncludes('const MAX_ATTACHMENTS = 8;', 'attachment count limit should be defined');
expectIncludes('const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;', 'per-file attachment limit should be defined');
expectIncludes('const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024;', 'total attachment limit should be defined');
expectIncludes('function normalizePromptAttachments(raw: unknown): PromptAttachment[]', 'attachments should be normalized through a helper');
expectIncludes('function inferAttachmentMimeType(name: string, mimeType: string): string', 'generic attachment MIME types should be inferred from filename');
expectIncludes("cs: 'text/x-csharp'", 'C# attachments should be normalized from extension');
expectIncludes("cpp: 'text/x-c++'", 'C++ attachments should be normalized from extension');
expectIncludes("java: 'text/x-java-source'", 'Java attachments should be normalized from extension');
expectIncludes("go: 'text/x-go'", 'Go attachments should be normalized from extension');
expectIncludes("mjs: 'text/javascript'", 'MJS attachments should be normalized from extension');
expectIncludes("svg: 'image/svg+xml'", 'SVG attachments should be normalized from extension');
expectIncludes("pem: 'application/x-pem-file'", 'PEM attachments should be normalized from extension');
expectIncludes("'.env.local': 'text/plain'", 'dot-env attachments should be normalized by basename');
expectIncludes("ps1: 'text/x-powershell'", 'PowerShell attachments should be normalized from extension');
expectIncludes("'text/x-powershell'", 'PowerShell attachments should be allowed by backend validation');
expectIncludes("mimeType.startsWith('text/')", 'text-based code attachments should be allowed by backend validation');
expectIncludes('const parsedMimeType = parsed ? inferAttachmentMimeType(name, parsed.mimeType) :', 'data URL MIME type should be normalized before validation');
expectIncludes("throw new AttachmentValidationError('invalid_attachments')", 'invalid attachments should return explicit validation errors');
expectIncludes("throw new AttachmentValidationError('attachment_too_large')", 'oversized attachments should return explicit validation errors');
expectIncludes("throw new AttachmentValidationError('too_many_attachments')", 'too many attachments should return explicit validation errors');
expectIncludes('function buildPromptParts(text: string, attachments: PromptAttachment[] = [])', 'ACP prompt parts should be built through a helper');
expectIncludes("type: 'image'", 'image prompt parts should be generated');
expectIncludes('function buildAttachmentTextBlocks(attachments: PromptAttachment[]): string', 'text file attachments should be injected into the text prompt');
expectIncludes('Attached file content:\\n\\n${blocks.join', 'file prompt text should include decoded attachment content');
expectIncludes('Attached file(s):\\n${summary}', 'prompt text should include an attachment summary fallback');
expectIncludes("if (!parsed || parsedMimeType !== mimeType || !isAllowedAttachmentMimeType(mimeType))", 'unsupported attachment MIME types should be rejected');
expectIncludes('attachments = normalizePromptAttachments(body?.attachments)', 'send action should read body.attachments');
expectIncludes('if (!text && attachments.length === 0)', 'attachment-only sends should be allowed while empty sends are rejected');
expectIncludes('sendPrompt(proc, sess, agentId, text, isAdmin, userId, chatHistory, chatId, messageId, attachments)', 'sendPrompt should receive normalized attachments');
expectIncludes('prompt: promptParts', 'initial session/prompt should use buildPromptParts output');
expectIncludes('prompt: buildPromptParts(retryText, attachments)', 'retry session/prompt should use buildPromptParts output');

const sendPromptSignature = routeSource.match(/function sendPrompt\([^)]*attachments: PromptAttachment\[\] = \[\][^)]*\)/s);
assert.ok(sendPromptSignature, 'sendPrompt signature should accept attachments');

const invalidReturn = /catch \(err\) \{[\s\S]*AttachmentValidationError[\s\S]*NextResponse\.json\(\{ ok: false, error: err\.message \}, \{ status: err\.status \}\)/.test(routeSource);
assert.ok(invalidReturn, 'attachment validation failures should return explicit 400-style JSON errors');

console.log('acp attachment checks passed');
