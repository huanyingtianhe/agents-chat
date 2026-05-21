import React from 'react';
import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';

export const mdProcessor = remark()
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeStringify, { allowDangerousHtml: true });

export function markdownToHtml(md: string): string {
  return String(mdProcessor.processSync(md));
}

export function stripMarkdownSyntaxForSearch(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}

// Detect file paths ending in .html/.htm in text and wrap them with report links
export const HTML_FILE_RE = /(?:[A-Za-z]:\\|\/|~\/)[^\s"'<>*?|]+\.html?/gi;

export function linkifyHtmlPaths(text: string): (string | { href: string; label: string })[] {
  HTML_FILE_RE.lastIndex = 0;
  const parts: (string | { href: string; label: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(HTML_FILE_RE)) {
    const idx = m.index!;
    if (idx > last) parts.push(text.slice(last, idx));
    parts.push({ href: `/api/file?path=${encodeURIComponent(m[0])}`, label: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  HTML_FILE_RE.lastIndex = 0;
  return parts;
}

// Helper to safely test for HTML file paths, resetting lastIndex before and after
function hasHtmlFilePath(text: string): boolean {
  HTML_FILE_RE.lastIndex = 0;
  const result = HTML_FILE_RE.test(text);
  HTML_FILE_RE.lastIndex = 0;
  return result;
}

// Custom ReactMarkdown components to linkify HTML file paths in code blocks and paragraphs
export const mdComponents = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code: (props: any) => {
    const { children, className, ...rest } = props;
    const text = String(children || '');
    if (hasHtmlFilePath(text) && !className) {
      const segments = linkifyHtmlPaths(text);
      return (
        <code {...rest} className={className}>
          {segments.map((s, i) =>
            typeof s === 'string' ? s : <a key={i} href={s.href} target="_blank" rel="noopener noreferrer" className="htmlFileLink">{s.label}</a>
          )}
        </code>
      );
    }
    return <code {...rest} className={className}>{children}</code>;
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  p: (props: any) => {
    const { children, ...rest } = props;
    const processed = Array.isArray(children) ? children : [children];
    const result = processed.flatMap((child: unknown, ci: number) => {
      if (typeof child !== 'string') return [child];
      if (!hasHtmlFilePath(child)) return [child];
      const segments = linkifyHtmlPaths(child);
      return segments.map((s, si) =>
        typeof s === 'string' ? s : <a key={`${ci}-${si}`} href={s.href} target="_blank" rel="noopener noreferrer" className="htmlFileLink">{s.label}</a>
      );
    });
    return <p {...rest}>{result}</p>;
  },
};
