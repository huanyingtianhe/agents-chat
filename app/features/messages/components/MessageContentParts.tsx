'use client';

import { ChatMarkdown } from './ChatMarkdown';
import type { ContentPart } from '../../chat/chatTypes';
import { MessageToolCall } from './MessageToolCall';
import { getStatusDisplayText } from '../messageDisplayHelpers';
export function MessageContentParts({
  parts,
  pending,
  statusText,
}: {
  parts: ContentPart[];
  pending?: boolean;
  statusText?: string;
}) {
  return (
    <>
      {parts.map((part, pi) => {
        if (part.kind === 'thinking') {
          return (
            <div key={pi} className="thinkingPart">
              <div className="thinkingPartText">{part.text}</div>
            </div>
          );
        }
        if (part.kind === 'tool') {
          const displayName = statusText === 'Interrupted'
            && pi === parts.length - 1
            && part.toolName === 'Reading shell output'
            ? 'Interrupted shell output'
            : undefined;
          return <MessageToolCall key={pi} part={part} displayName={displayName} />;
        }
        if (part.kind === 'user_answer') {
          return (
            <div key={pi} className="userAnswerPart">
              <ChatMarkdown>{part.text}</ChatMarkdown>
            </div>
          );
        }
        if (part.kind === 'text') {
          return (
            <div key={pi} className={`messageContent markdownBody ${pending ? 'pending' : ''}`}>
              <ChatMarkdown>{part.text}</ChatMarkdown>
            </div>
          );
        }
        return null;
      })}
      {pending && (
        <div className="streamingIndicator">
          <span className="streamingPulse" />
          <span>{getStatusDisplayText(statusText, 'Generating')}</span>
        </div>
      )}
    </>
  );
}
