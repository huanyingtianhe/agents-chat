'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from '../markdownHelpers';
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
          return <MessageToolCall key={pi} part={part} />;
        }
        if (part.kind === 'user_answer') {
          return (
            <div key={pi} className="userAnswerPart">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        if (part.kind === 'text') {
          return (
            <div key={pi} className={`messageContent markdownBody ${pending ? 'pending' : ''}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{part.text}</ReactMarkdown>
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
