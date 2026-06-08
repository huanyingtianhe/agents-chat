'use client';

import { useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { mdComponents } from '../markdownHelpers';
import type { Agent } from '../../agents/agentTypes';
import type { ChatMessage, AgentUserRequestResponse } from '../../chat/chatTypes';
import type { FailedSendState } from '../../chat/components/FailedSendControls';
import { FailedSendActions, FailedSendNotice } from '../../chat/components/FailedSendControls';
import { AttachmentList } from '../../composer/components/AttachmentList';
import { AgentUserRequestCard } from './AgentUserRequestCard';
import { MessageContentParts } from './MessageContentParts';
import { WorkflowSaveButton } from '../../orchestration/components/WorkflowSaveButton';
import { getStatusDisplayText } from '../messageDisplayHelpers';
import { formatMessageTime } from '../../chat/chatHelpers';

function getMessageCopyText(message: ChatMessage): string {
  if (message.parts && message.parts.length > 0) {
    return message.parts
      .filter((part) => part.kind === 'text')
      .map((part) => (part as { kind: 'text'; text: string }).text)
      .join('') || message.content || '';
  }
  return message.content || '';
}

export function MessageBubble({
  message,
  agents,
  failedSend,
  isCollapsed,
  mounted,
  isCopied,
  isCopiedFormatted,
  onCopy,
  onCopyFormatted,
  onToggleExpanded,
  onRetryFailedSend,
  onOpenImage,
  onAnswerAgentUserRequest,
  onDismissAgentUserRequest,
}: {
  message: ChatMessage;
  agents: Agent[];
  failedSend: FailedSendState | null;
  isCollapsed: boolean;
  mounted: boolean;
  isCopied: boolean;
  isCopiedFormatted: boolean;
  onCopy: () => void;
  onCopyFormatted: (html: string, text: string) => void;
  onToggleExpanded: () => void;
  onRetryFailedSend: () => void;
  onOpenImage: (src: string) => void;
  onAnswerAgentUserRequest: (requestId: string, response: AgentUserRequestResponse) => Promise<void>;
  onDismissAgentUserRequest: (requestId: string) => void;
}) {
  const hasParts = message.parts && message.parts.length > 0;
  const isLong = (message.content || '').length > 400 || (message.content || '').split('\n').length > 12;
  const messageActionsClassName = `messageActions ${failedSend ? 'messageActionsWithFailure' : ''}`;
  const partsContentRef = useRef<HTMLDivElement | null>(null);
  const markdownContentRef = useRef<HTMLDivElement | null>(null);
  const handleCopyFormatted = (ref: React.MutableRefObject<HTMLDivElement | null>, partsMode: boolean) => () => {
    const node = ref.current;
    if (!node) {
      const fallback = getMessageCopyText(message);
      onCopyFormatted('', fallback);
      return;
    }
    let htmlParts: string[] = [];
    let textParts: string[] = [];
    if (partsMode) {
      const answerNodes = node.querySelectorAll<HTMLElement>(':scope > .messageContent.markdownBody, :scope > .userAnswerPart');
      answerNodes.forEach((el) => {
        htmlParts.push(el.innerHTML);
        textParts.push(el.innerText || el.textContent || '');
      });
    } else {
      htmlParts.push(node.innerHTML);
      textParts.push(node.innerText || node.textContent || '');
    }
    const html = htmlParts.join('\n');
    const text = textParts.join('\n').trim() || getMessageCopyText(message);
    onCopyFormatted(html, text);
  };

  return (
    <div className={`message ${message.type} ${message.pending ? 'streamingMessage' : ''} ${message.summary ? 'summaryCard' : ''}`}>
      {message.type !== 'user' && (
        <div className="messageHeader">
          <span className="agentName">
            {message.type === 'system' ? 'System' : (agents.find((a) => a.id === message.agentId)?.name || message.agentId || 'agent')}
          </span>
          {message.round ? <span className="messageMetaTag">Round {message.round}</span> : null}
          {message.relation ? <span className="messageMetaTag">{message.relation}</span> : null}
          <span suppressHydrationWarning>{mounted ? formatMessageTime(message.ts) : ''}</span>
        </div>
      )}
      {message.pending && !message.content && !(message.parts && message.parts.length > 0) && !message.userRequest ? (
        <div className="thinkingWrap">
          <span className="thinkingText">{getStatusDisplayText(message.statusText, 'Thinking')}</span>
          <span className="thinkingDots"><span /><span /><span /></span>
        </div>
      ) : (
        <>
          {message.pending && message.statusText && !hasParts ? <div className="ptyStatusBadge">{getStatusDisplayText(message.statusText, 'Generating')}</div> : null}
          {hasParts ? (() => {
            const totalText = message.parts!.filter(p => p.kind === 'text').map(p => (p as { kind: 'text'; text: string }).text).join('');
            const partsLong = totalText.length > 400 || totalText.split('\n').length > 12 || message.parts!.length > 6;
            return (
              <>
                <FailedSendNotice failure={failedSend} />
                <div ref={partsContentRef} className={`partsStream ${partsLong && isCollapsed && !message.pending ? 'collapsed' : ''}`}>
                  <MessageContentParts
                    parts={message.parts!}
                    pending={message.pending}
                    statusText={message.statusText}
                  />
                </div>
                <AttachmentList attachments={message.attachments} mode="message" onPreview={onOpenImage} />
                {message.userRequest && (
                  <AgentUserRequestCard
                    request={message.userRequest}
                    disabled={false}
                    onAnswer={onAnswerAgentUserRequest}
                    onDismiss={onDismissAgentUserRequest}
                  />
                )}
                <div className={messageActionsClassName}>
                  {partsLong && !message.pending && (
                    <button className="collapseToggle" onClick={onToggleExpanded}>
                      {isCollapsed ? 'Expand' : 'Collapse'}
                    </button>
                  )}
                  <FailedSendActions message={message} failure={failedSend} onResend={() => onRetryFailedSend()} />
                  {message.type !== 'user' && (
                    <>
                      <button
                        type="button"
                        className="messageCopyButton"
                        aria-label="Copy answer"
                        title="Copy answer"
                        onClick={onCopy}
                      >
                        {isCopied ? 'Copied' : 'Copy'}
                      </button>
                      <button
                        type="button"
                        className="messageCopyButton"
                        aria-label="Copy answer with formatting"
                        title="Copy with formatting preserved (paste into Word, email, etc.)"
                        onClick={handleCopyFormatted(partsContentRef, true)}
                      >
                        {isCopiedFormatted ? 'Copied' : 'Copy with format'}
                      </button>
                      <WorkflowSaveButton content={getMessageCopyText(message)} />
                    </>
                  )}
                </div>
              </>
            );
          })() : (
            <>
              <FailedSendNotice failure={failedSend} />
              <div ref={markdownContentRef} className={`messageContent markdownBody ${message.pending ? 'pending' : ''} ${isLong && isCollapsed ? 'collapsed' : ''}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{message.content}</ReactMarkdown>
              </div>
              <AttachmentList attachments={message.attachments} mode="message" onPreview={onOpenImage} />
              {message.pending && message.content && (
                <div className="streamingIndicator">
                  <span className="streamingPulse" />
                  <span>{getStatusDisplayText(message.statusText, 'Generating')}</span>
                </div>
              )}
              {message.userRequest && (
                <AgentUserRequestCard
                  request={message.userRequest}
                  disabled={false}
                  onAnswer={onAnswerAgentUserRequest}
                  onDismiss={onDismissAgentUserRequest}
                />
              )}
              <div className={messageActionsClassName}>
                {isLong && (
                  <button className="collapseToggle" onClick={onToggleExpanded}>
                    {isCollapsed ? 'Expand' : 'Collapse'}
                  </button>
                )}
                <FailedSendActions message={message} failure={failedSend} onResend={() => onRetryFailedSend()} />
                {message.type !== 'user' && (
                  <>
                    <button
                      type="button"
                      className="messageCopyButton"
                      aria-label="Copy answer"
                      title="Copy answer"
                      onClick={onCopy}
                    >
                      {isCopied ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      type="button"
                      className="messageCopyButton"
                      aria-label="Copy answer with formatting"
                      title="Copy with formatting preserved (paste into Word, email, etc.)"
                      onClick={handleCopyFormatted(markdownContentRef, false)}
                    >
                      {isCopiedFormatted ? 'Copied' : 'Copy with format'}
                    </button>
                    <WorkflowSaveButton content={message.content || ''} />
                  </>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

export { getMessageCopyText };
