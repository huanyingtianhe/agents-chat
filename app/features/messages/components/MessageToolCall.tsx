'use client';

import type { ContentPart } from '../../chat/chatTypes';

type ToolPart = ContentPart & { kind: 'tool' };

export function MessageToolCall({ part }: { part: ToolPart }) {
  return (
    <details className="toolCallItem" open={!part.done}>
      <summary className={`toolCallSummary ${part.done ? 'complete' : 'running'}`}>
        <span className="toolCallIcon">{part.done ? '✅' : '⏳'}</span>
        <span className="toolCallName">{part.toolName}</span>
      </summary>
      {part.args && (
        <pre className="toolCallDetail">
          {part.args.length > 500 ? part.args.slice(0, 500) + '…' : part.args}
        </pre>
      )}
      {part.result && (
        <pre className="toolCallDetail toolCallResult">
          {part.result.length > 500 ? part.result.slice(0, 500) + '…' : part.result}
        </pre>
      )}
    </details>
  );
}
