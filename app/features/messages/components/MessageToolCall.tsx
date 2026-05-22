'use client';

import { useMemo } from 'react';
import type { ContentPart } from '../../chat/chatTypes';

type ToolPart = ContentPart & { kind: 'tool' };

const MAX_DISPLAY_CHARS = 2000;

/**
 * Tool call args/results are typically JSON.stringify'd payloads, which means
 * any embedded newlines/tabs appear as literal `\n` / `\r\n` / `\t` escape
 * sequences. Pretty-print the JSON when possible and convert those escapes back
 * to real whitespace so the content reads naturally in a <pre> block.
 */
function prettifyToolPayload(raw: string | undefined | null): string {
  if (!raw) return '';
  let text = raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      text = JSON.stringify(parsed, null, 2);
    }
  } catch {
    // not JSON — fall through and unescape any literal escape sequences below
  }
  text = text
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\\t/g, '\t');
  if (text.length > MAX_DISPLAY_CHARS) text = text.slice(0, MAX_DISPLAY_CHARS) + '…';
  return text;
}

export function MessageToolCall({ part }: { part: ToolPart }) {
  const argsText = useMemo(() => prettifyToolPayload(part.args), [part.args]);
  const resultText = useMemo(() => prettifyToolPayload(part.result), [part.result]);
  return (
    <details className="toolCallItem" open={!part.done}>
      <summary className={`toolCallSummary ${part.done ? 'complete' : 'running'}`}>
        <span className="toolCallIcon">{part.done ? '✅' : '⏳'}</span>
        <span className="toolCallName">{part.toolName}</span>
      </summary>
      {argsText && (
        <pre className="toolCallDetail">{argsText}</pre>
      )}
      {resultText && (
        <pre className="toolCallDetail toolCallResult">{resultText}</pre>
      )}
    </details>
  );
}
