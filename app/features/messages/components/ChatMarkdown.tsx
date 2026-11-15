'use client';

import { createContext, useContext, type ComponentProps } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseFileReference, type FileReference } from '../../files/fileReference';
import { mdComponents } from '../markdownHelpers';
import { remarkFileReferences } from '../remarkFileReferences';

type OpenFileReference = (reference: FileReference, agentId: string | undefined, trigger: HTMLElement) => void;

export const OpenFileReferenceContext = createContext<OpenFileReference | null>(null);
export const MessageAgentContext = createContext<string | undefined>(undefined);

function ChatFileAnchor({ href, children, title }: ComponentProps<'a'>) {
  const openFile = useContext(OpenFileReferenceContext);
  const agentId = useContext(MessageAgentContext);
  const file = href && parseFileReference(href, true);
  if (!file || !openFile) return <a href={href} title={title}>{children}</a>;
  return (
    <button type="button" className="messageFileLink" title={href}
      onClick={event => openFile(file, agentId, event.currentTarget)}>
      {children}
    </button>
  );
}

const chatComponents: Components = {
  ...mdComponents,
  code: ({ node: _node, ...props }) => parseFileReference(String(props.children ?? ''), true)
    ? <code {...props} />
    : mdComponents.code(props),
  a: ChatFileAnchor,
};

export function ChatMarkdown({ children }: { children: string }) {
  const enableFileLinks = useContext(OpenFileReferenceContext) !== null;
  return (
    <ReactMarkdown
      remarkPlugins={enableFileLinks ? [remarkGfm, remarkFileReferences] : [remarkGfm]}
      urlTransform={(url, key) => enableFileLinks && key === 'href' && parseFileReference(url, true) ? url : defaultUrlTransform(url)}
      components={enableFileLinks ? chatComponents : mdComponents}
    >
      {children}
    </ReactMarkdown>
  );
}
