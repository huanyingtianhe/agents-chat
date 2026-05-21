import { stripMarkdownSyntaxForSearch } from '../../messages/markdownHelpers';
import type { CommentAddRange, FileComment, LiveSelectionDraftAnchor } from '../fileWorkspaceTypes';

export function getTextOffsetInRoot(root: Node, container: Node, offset: number): number | null {
  try {
    const range = document.createRange();
    range.setStart(root, 0);
    range.setEnd(container, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

export function getTextPositionInRoot(root: Node, textOffset: number): { node: Node; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, textOffset);
  let node: Node | null;
  let lastTextNode: Text | null = null;
  while ((node = walker.nextNode())) {
    const textNode = node as Text;
    const length = textNode.textContent?.length ?? 0;
    lastTextNode = textNode;
    if (remaining <= length) return { node: textNode, offset: remaining };
    remaining -= length;
  }
  if (lastTextNode) return { node: lastTextNode, offset: lastTextNode.textContent?.length ?? 0 };
  return { node: root, offset: 0 };
}

export function findLiveEditTextRangeInRoot(root: Node, selectedText: string, occurrenceIndex = 0): Range | null {
  const searchText = selectedText.trim();
  if (!searchText) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  let remainingSingleNode = Math.max(0, occurrenceIndex);
  while ((node = walker.nextNode())) {
    const text = node.textContent || '';
    let from = 0;
    while (from <= text.length) {
      const index = text.indexOf(searchText, from);
      if (index < 0) break;
      if (remainingSingleNode === 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + searchText.length);
        return range;
      }
      remainingSingleNode--;
      from = index + searchText.length;
    }
    nodes.push(node as Text);
  }
  if (nodes.length === 0) return null;

  let joined = '';
  const offsets: number[] = [];
  for (const n of nodes) {
    offsets.push(joined.length);
    joined += n.textContent || '';
  }

  const findOffsetNode = (offset: number): { node: Text; localOffset: number } | null => {
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    const n = nodes[lo];
    const localOffset = offset - offsets[lo];
    const len = (n.textContent || '').length;
    return localOffset < 0 || localOffset > len ? null : { node: n, localOffset };
  };

  const buildRangeAt = (rawStart: number, rawEnd: number): Range | null => {
    const start = findOffsetNode(rawStart);
    const end = findOffsetNode(rawEnd);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.localOffset);
    range.setEnd(end.node, end.localOffset);
    return range;
  };

  const candidates = [searchText, searchText.replace(/\s+/g, ' ')];
  const normalizedJoined = joined.replace(/\s+/g, ' ');
  for (const candidate of candidates) {
    let remaining = Math.max(0, occurrenceIndex);
    let from = 0;
    while (from <= joined.length) {
      const direct = joined.indexOf(candidate, from);
      if (direct < 0) break;
      if (remaining === 0) {
        const range = buildRangeAt(direct, direct + candidate.length);
        if (range) return range;
      }
      remaining--;
      from = direct + candidate.length;
    }
    const normIdx = normalizedJoined.indexOf(candidate);
    if (normIdx < 0) continue;
    let rawStart = -1;
    let rawEnd = -1;
    let raw = 0;
    let norm = 0;
    let prevWasSpace = false;
    while (raw < joined.length) {
      if (rawStart < 0 && norm === normIdx) rawStart = raw;
      if (norm === normIdx + candidate.length) {
        rawEnd = raw;
        break;
      }
      const ch = joined[raw];
      if (/\s/.test(ch)) {
        if (!prevWasSpace) norm++;
        prevWasSpace = true;
      } else {
        norm++;
        prevWasSpace = false;
      }
      raw++;
    }
    if (rawStart < 0 && norm >= normIdx) rawStart = raw;
    if (rawEnd < 0) rawEnd = joined.length;
    const range = buildRangeAt(rawStart, rawEnd);
    if (range) return range;
  }
  return null;
}

export function countSourceOccurrencesBeforeInContent(content: string, searchText: string, line: number | null | undefined, char: number | null | undefined): number {
  const trimmed = searchText.trim();
  if (!trimmed) return 0;
  const lines = content.split('\n');
  const targetLine = Math.max(1, line ?? 1) - 1;
  const targetChar = Math.max(0, char ?? 0);
  let absolute = 0;
  for (let i = 0; i < targetLine && i < lines.length; i++) absolute += lines[i].length + 1;
  if (targetLine < lines.length) absolute += Math.min(targetChar, lines[targetLine].length);
  let count = 0;
  let from = 0;
  while (from < absolute) {
    const idx = content.indexOf(trimmed, from);
    if (idx < 0 || idx >= absolute) break;
    count++;
    from = idx + trimmed.length;
  }
  return count;
}

export function getCommentSourceTextFromContent(content: string, comment: FileComment): string | null {
  if (comment.rangeStartLine == null) return null;
  const lines = content.split('\n');
  const startIdx = comment.rangeStartLine - 1;
  const endIdx = (comment.rangeEndLine ?? comment.rangeStartLine) - 1;
  if (startIdx < 0 || endIdx < startIdx || startIdx >= lines.length) return null;
  if (comment.rangeStartChar != null && comment.rangeEndChar != null) {
    if (startIdx === endIdx) return (lines[startIdx] || '').slice(comment.rangeStartChar, comment.rangeEndChar);
    const selectedLines = lines.slice(startIdx, Math.min(endIdx + 1, lines.length));
    if (selectedLines.length === 0) return null;
    selectedLines[0] = selectedLines[0].slice(comment.rangeStartChar);
    selectedLines[selectedLines.length - 1] = selectedLines[selectedLines.length - 1].slice(0, comment.rangeEndChar);
    return selectedLines.join('\n');
  }
  return lines.slice(startIdx, Math.min(endIdx + 1, lines.length)).join('\n');
}

export function getLiveSelectionDraftAnchorForRange(root: Element, range: Range): LiveSelectionDraftAnchor | null {
  const editor = root.closest('.mdEditorLive');
  if (!(editor instanceof HTMLElement)) return null;
  const editorRect = editor.getBoundingClientRect();
  const rects = Array.from(range.getClientRects())
    .filter(rect => rect.width > 0 && rect.height > 0)
    .map(rect => ({
      left: rect.left - editorRect.left + editor.scrollLeft,
      top: rect.top - editorRect.top + editor.scrollTop,
      width: rect.width,
      height: rect.height,
    }));
  return rects.length > 0 ? { rects } : null;
}

export function getLiveEditCommentRangeFromSelection(content: string, selectedText: string): CommentAddRange | null {
  const lines = content.split('\n');
  const normalizeSelectionText = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const searchNorm = normalizeSelectionText(selectedText);
  if (!searchNorm) return null;
  const buildSearchIndex = (lineTexts: string[]) => {
    const lineEnd = new Int32Array(lines.length);
    let cursor = 0;
    let joined = '';
    let hasContent = false;
    for (let i = 0; i < lines.length; i++) {
      const n = lineTexts[i];
      if (n) {
        if (hasContent) {
          joined += ' ';
          cursor += 1;
        }
        joined += n;
        cursor += n.length;
        hasContent = true;
      }
      lineEnd[i] = cursor;
    }
    return { joined, lineEnd };
  };

  for (const { joined, lineEnd } of [
    buildSearchIndex(lines.map(normalizeSelectionText)),
    buildSearchIndex(lines.map(line => normalizeSelectionText(stripMarkdownSyntaxForSearch(line)))),
  ]) {
    const matchStart = joined.indexOf(searchNorm);
    if (matchStart < 0) continue;
    const matchEnd = matchStart + searchNorm.length - 1;
    const findLine = (offset: number): number => {
      let lo = 0;
      let hi = lineEnd.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (lineEnd[mid] <= offset) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const si = findLine(matchStart);
    const ei = findLine(matchEnd);
    let startChar: number | undefined;
    let endChar: number | undefined;
    if (si === ei) {
      const rawIndex = lines[si].toLowerCase().indexOf(selectedText.toLowerCase());
      if (rawIndex >= 0) {
        startChar = rawIndex;
        endChar = rawIndex + selectedText.length;
      }
    }
    return { startLine: si + 1, endLine: ei + 1, startChar, endChar };
  }
  return null;
}
