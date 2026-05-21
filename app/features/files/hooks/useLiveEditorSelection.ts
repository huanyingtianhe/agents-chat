'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import { stripMarkdownSyntaxForSearch } from '../../messages/markdownHelpers';
import {
  countSourceOccurrencesBeforeInContent,
  findLiveEditTextRangeInRoot,
  getCommentSourceTextFromContent,
  getLiveEditCommentRangeFromSelection,
  getLiveSelectionDraftAnchorForRange,
  getTextOffsetInRoot,
  getTextPositionInRoot,
} from './liveEditorSelectionAlgorithms';
import { FILE_REVIEW_LINE_HEIGHT, isMarkdownFile } from '../fileWorkspaceHelpers';
import type { CommentAddRange, FileComment, LiveCommentMarker, LiveEditorSelectionSnapshot, LiveSelectionDraftAnchor } from '../fileWorkspaceTypes';
import type { UseFileWorkspaceStateResult } from './useFileWorkspaceState';

export type UseLiveEditorSelectionDeps = {
  workspace: UseFileWorkspaceStateResult;
  fileComments: FileComment[];
  selectedCommentId: string | null;
  commentSidebarOpen: boolean;
  commentAddRange: CommentAddRange | null;
  showCommentInput: boolean;
  setCommentSourceScrollTop: (scrollTop: number) => void;
  setCommentAddRange: (range: CommentAddRange | null) => void;
  setShowCommentInput: (show: boolean) => void;
  setCommentSidebarOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  getCommentsByLine: () => Map<number, FileComment[]>;
};

export type UseLiveEditorSelectionResult = {
  liveSelectionDraftAnchor: LiveSelectionDraftAnchor | null;
  setLiveSelectionDraftAnchor: (anchor: LiveSelectionDraftAnchor | null) => void;
  liveCommentMarkers: LiveCommentMarker[];
  fileContentRef: MutableRefObject<HTMLDivElement | null>;
  mdLiveContainerRef: MutableRefObject<HTMLDivElement | null>;
  liveEditCommentBtnRef: MutableRefObject<HTMLButtonElement | null>;
  pendingLiveEditCommentRangeRef: MutableRefObject<CommentAddRange | null>;
  pendingLiveEditCommentAnchorRef: MutableRefObject<LiveSelectionDraftAnchor | null>;
  pendingLiveEditDomRangeRef: MutableRefObject<Range | null>;
  pendingLiveEditSelectedTextRef: MutableRefObject<string | null>;
  pendingLiveEditorSelectionRef: MutableRefObject<LiveEditorSelectionSnapshot | null>;
  liveSelectionDraftRangeRef: MutableRefObject<Range | null>;
  liveSelectionDraftTextRef: MutableRefObject<string | null>;
  recentLiveCommentAnchorsRef: MutableRefObject<Map<string, number>>;
  liveEditSelectionRef: MutableRefObject<() => void>;
  handleTextSelection: () => void;
  handleFileContentScroll: () => void;
  handleLiveEditorScroll: () => void;
  captureLiveEditorSelection: () => LiveEditorSelectionSnapshot | null;
  restoreLiveEditorSelection: (snapshot: LiveEditorSelectionSnapshot) => void;
  clearLiveSelectionDraft: () => void;
  hideLiveEditCommentButton: () => void;
  findLiveEditTextRange: (selectedText: string, occurrenceIndex?: number) => Range | null;
  countSourceOccurrencesBefore: (searchText: string, line: number | null | undefined, char: number | null | undefined) => number;
  getCommentSourceText: (comment: FileComment) => string | null;
  getLiveEditRangeForComment: (comment: FileComment) => Range | null;
  getLiveSelectionDraftAnchor: (range: Range) => LiveSelectionDraftAnchor | null;
  getLiveCommentMarkersForEditor: () => LiveCommentMarker[];
  positionLiveEditCommentButton: (range: Range) => void;
  handleLiveEditSelection: () => void;
  handleLiveEditableBeforeInput: (event: FormEvent<HTMLDivElement>) => void;
  handleLiveEditableInput: () => void;
  startPendingLiveCommentDraft: () => void;
};

export function useLiveEditorSelection({
  workspace,
  fileComments,
  selectedCommentId,
  commentSidebarOpen,
  commentAddRange,
  showCommentInput,
  setCommentSourceScrollTop,
  setCommentAddRange,
  setShowCommentInput,
  setCommentSidebarOpen,
  getCommentsByLine,
}: UseLiveEditorSelectionDeps): UseLiveEditorSelectionResult {
  const [liveSelectionDraftAnchor, setLiveSelectionDraftAnchor] = useState<LiveSelectionDraftAnchor | null>(null);
  const [liveCommentMarkers, setLiveCommentMarkers] = useState<LiveCommentMarker[]>([]);
  const fileContentRef = useRef<HTMLDivElement>(null);
  const mdLiveContainerRef = useRef<HTMLDivElement>(null);
  const liveEditCommentBtnRef = useRef<HTMLButtonElement>(null);
  const pendingLiveEditCommentRangeRef = useRef<CommentAddRange | null>(null);
  const pendingLiveEditCommentAnchorRef = useRef<LiveSelectionDraftAnchor | null>(null);
  const pendingLiveEditDomRangeRef = useRef<Range | null>(null);
  const pendingLiveEditSelectedTextRef = useRef<string | null>(null);
  const preserveLiveEditCommentButtonOnCollapseRef = useRef(false);
  const pendingLiveEditorSelectionRef = useRef<LiveEditorSelectionSnapshot | null>(null);
  const liveSelectionDraftRangeRef = useRef<Range | null>(null);
  const liveSelectionDraftTextRef = useRef<string | null>(null);
  const recentLiveCommentAnchorsRef = useRef<Map<string, number>>(new Map());

  const handleCommentSourceScroll = useCallback((source: HTMLDivElement | null) => {
    if (source) setCommentSourceScrollTop(source.scrollTop);
  }, [setCommentSourceScrollTop]);

  const handleFileContentScroll = useCallback(() => handleCommentSourceScroll(fileContentRef.current), [handleCommentSourceScroll]);
  const handleLiveEditorScroll = useCallback(() => handleCommentSourceScroll(mdLiveContainerRef.current), [handleCommentSourceScroll]);


  const captureLiveEditorSelection = useCallback((): LiveEditorSelectionSnapshot | null => {
    const root = workspace.mdLiveRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const start = getTextOffsetInRoot(root, range.startContainer, range.startOffset);
    const end = getTextOffsetInRoot(root, range.endContainer, range.endOffset);
    return start == null || end == null ? null : { start, end };
  }, [workspace.mdLiveRef]);


  const restoreLiveEditorSelection = useCallback((snapshot: LiveEditorSelectionSnapshot) => {
    const root = workspace.mdLiveRef.current;
    if (!root) return;
    const start = getTextPositionInRoot(root, snapshot.start);
    const end = getTextPositionInRoot(root, snapshot.end);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(range);
  }, [workspace.mdLiveRef]);

  const handleTextSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !fileContentRef.current) return;
    const range = sel.getRangeAt(0);
    const container = fileContentRef.current;
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;
    const startLineEl = range.startContainer.parentElement?.closest('[data-line-num]');
    const endLineEl = range.endContainer.parentElement?.closest('[data-line-num]');
    if (!startLineEl || !endLineEl) return;
    const startLine = parseInt(startLineEl.getAttribute('data-line-num') || '0', 10);
    const endLine = parseInt(endLineEl.getAttribute('data-line-num') || '0', 10);
    if (startLine > 0 && endLine > 0) {
      setCommentAddRange({ startLine: Math.min(startLine, endLine), endLine: Math.max(startLine, endLine) });
    }
  }, [setCommentAddRange]);

  const clearLiveSelectionDraft = useCallback(() => {
    liveSelectionDraftRangeRef.current = null;
    liveSelectionDraftTextRef.current = null;
    setLiveSelectionDraftAnchor(null);
  }, []);

  const hideLiveEditCommentButton = useCallback(() => {
    preserveLiveEditCommentButtonOnCollapseRef.current = false;
    pendingLiveEditCommentRangeRef.current = null;
    pendingLiveEditCommentAnchorRef.current = null;
    pendingLiveEditDomRangeRef.current = null;
    pendingLiveEditSelectedTextRef.current = null;
    const button = liveEditCommentBtnRef.current;
    if (button) button.style.display = 'none';
  }, []);

  const findLiveEditTextRange = useCallback((selectedText: string, occurrenceIndex = 0): Range | null => {
    const root = workspace.mdLiveRef.current;
    return root ? findLiveEditTextRangeInRoot(root, selectedText, occurrenceIndex) : null;
  }, [workspace.mdLiveRef]);

  const countSourceOccurrencesBefore = useCallback((searchText: string, line: number | null | undefined, char: number | null | undefined): number => {
    return countSourceOccurrencesBeforeInContent(workspace.mdEditContent, searchText, line, char);
  }, [workspace.mdEditContent]);

  const getCommentSourceText = useCallback((comment: FileComment): string | null => {
    return getCommentSourceTextFromContent(workspace.mdEditContent, comment);
  }, [workspace.mdEditContent]);

  const getLiveEditRangeForComment = useCallback((comment: FileComment): Range | null => {
    const selectedText = getCommentSourceText(comment);
    if (!selectedText) return null;
    const renderedText = stripMarkdownSyntaxForSearch(selectedText).trim();
    const candidates = Array.from(new Set([selectedText.trim(), renderedText].filter(Boolean)));
    for (const candidate of candidates) {
      const occurrenceIndex = countSourceOccurrencesBefore(candidate, comment.rangeStartLine, comment.rangeStartChar);
      const range = findLiveEditTextRange(candidate, occurrenceIndex) || findLiveEditTextRange(candidate, 0);
      if (range) return range;
    }
    return null;
  }, [countSourceOccurrencesBefore, findLiveEditTextRange, getCommentSourceText]);

  const getLiveSelectionDraftAnchor = useCallback((range: Range): LiveSelectionDraftAnchor | null => {
    const root = workspace.mdLiveRef.current;
    return root ? getLiveSelectionDraftAnchorForRange(root, range) : null;
  }, [workspace.mdLiveRef]);

  const getLiveCommentMarkersForEditor = useCallback((): LiveCommentMarker[] => {
    const editor = workspace.mdLiveRef.current?.closest('.mdEditorLive');
    if (!(editor instanceof HTMLElement)) return [];
    const editorRect = editor.getBoundingClientRect();
    const markers: LiveCommentMarker[] = [];
    for (const [lineNum, commentsForLine] of getCommentsByLine()) {
      const markerComment = commentsForLine.find(c => c.id === selectedCommentId) || commentsForLine[0];
      if (!markerComment) continue;
      const range = getLiveEditRangeForComment(markerComment);
      let top = Math.max(0, ((markerComment.rangeStartLine ?? 1) - 1) * FILE_REVIEW_LINE_HEIGHT) + 1;
      const recentAnchor = recentLiveCommentAnchorsRef.current.get(markerComment.id);
      if (recentAnchor != null) top = Math.max(8, recentAnchor);
      else if (range) {
        const rects = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
        const rect = rects[0] || range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) top = Math.max(8, rect.top - editorRect.top + editor.scrollTop + rect.height / 2 - 9);
      }
      const markerColor = (commentsForLine.find(c => c.authorType === 'agent') || markerComment).authorType === 'agent'
        ? 'var(--comment-agent-color)'
        : 'var(--comment-user-color)';
      markers.push({
        lineNum,
        commentIds: commentsForLine.map(c => c.id),
        top,
        left: Math.max(8, editor.scrollLeft + editor.clientWidth - 44),
        color: markerColor,
        selected: commentsForLine.some(c => c.id === selectedCommentId),
        label: `${commentsForLine.length} comment${commentsForLine.length === 1 ? '' : 's'} on line ${lineNum}`,
        title: commentsForLine.map(c => c.content).join('\n'),
        count: commentsForLine.length,
      });
    }
    return markers;
  }, [getCommentsByLine, getLiveEditRangeForComment, selectedCommentId, workspace.mdLiveRef]);

  const positionLiveEditCommentButton = useCallback((range: Range) => {
    const button = liveEditCommentBtnRef.current;
    const editor = workspace.mdLiveRef.current?.closest('.mdEditorLive');
    if (!button || !(editor instanceof HTMLElement)) return;
    const rectList = Array.from(range.getClientRects()).filter(rect => rect.width > 0 && rect.height > 0);
    const rect = rectList[rectList.length - 1] || range.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    button.style.display = 'inline-flex';
    button.style.top = `${Math.max(8, rect.bottom - editorRect.top + editor.scrollTop + 6)}px`;
    button.style.left = `${Math.max(8, Math.min(rect.right - editorRect.left + editor.scrollLeft + 8, editor.clientWidth - button.offsetWidth - 8))}px`;
    button.style.right = 'auto';
  }, [workspace.mdLiveRef]);

  const handleLiveEditSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!workspace.mdLiveRef.current) { hideLiveEditCommentButton(); return; }
    if (!sel || sel.isCollapsed) {
      const button = liveEditCommentBtnRef.current;
      if (preserveLiveEditCommentButtonOnCollapseRef.current && pendingLiveEditCommentRangeRef.current && button && button.style.display !== 'none') {
        preserveLiveEditCommentButtonOnCollapseRef.current = false;
        return;
      }
      hideLiveEditCommentButton();
      return;
    }
    const range = sel.getRangeAt(0);
    if (!workspace.mdLiveRef.current.contains(range.startContainer) || !workspace.mdLiveRef.current.contains(range.endContainer)) {
      hideLiveEditCommentButton();
      return;
    }
    const selectedText = sel.toString().trim();
    const commentRange = getLiveEditCommentRangeFromSelection(workspace.mdEditContent, selectedText);
    if (commentRange) {
      pendingLiveEditCommentRangeRef.current = commentRange;
      pendingLiveEditCommentAnchorRef.current = getLiveSelectionDraftAnchor(range);
      pendingLiveEditDomRangeRef.current = range.cloneRange();
      pendingLiveEditSelectedTextRef.current = selectedText;
      preserveLiveEditCommentButtonOnCollapseRef.current = true;
      positionLiveEditCommentButton(range);
    } else {
      hideLiveEditCommentButton();
    }
  }, [getLiveSelectionDraftAnchor, hideLiveEditCommentButton, positionLiveEditCommentButton, workspace.mdEditContent, workspace.mdLiveRef]);

  const liveEditSelectionRef = useRef(handleLiveEditSelection);
  liveEditSelectionRef.current = handleLiveEditSelection;

  const handleLiveEditableBeforeInput = useCallback((event: FormEvent<HTMLDivElement>) => {
    const snapshot = captureLiveEditorSelection();
    if (!snapshot) return;
    const inputEvent = event.nativeEvent as InputEvent;
    if (inputEvent.inputType === 'deleteContentBackward' && snapshot.start === snapshot.end) {
      const nextOffset = Math.max(0, snapshot.start - 1);
      pendingLiveEditorSelectionRef.current = { start: nextOffset, end: nextOffset };
    } else if (inputEvent.inputType === 'insertText' && typeof inputEvent.data === 'string') {
      const nextOffset = snapshot.start + inputEvent.data.length;
      pendingLiveEditorSelectionRef.current = { start: nextOffset, end: nextOffset };
    } else {
      pendingLiveEditorSelectionRef.current = { start: snapshot.start, end: snapshot.start };
    }
  }, [captureLiveEditorSelection]);

  const handleLiveEditableInput = useCallback(() => {
    if (!workspace.mdLiveRef.current) return;
    const selectionSnapshot = pendingLiveEditorSelectionRef.current || captureLiveEditorSelection();
    pendingLiveEditorSelectionRef.current = selectionSnapshot;
    const html = workspace.mdLiveRef.current.innerHTML;
    const md = workspace.turndownRef.current!.turndown(html);
    workspace.setMdLiveHtml(html);
    workspace.setMdEditContent(md);
    workspace.setMdDirty(md !== workspace.mdFileContent);
    if (selectionSnapshot) window.requestAnimationFrame(() => restoreLiveEditorSelection(selectionSnapshot));
  }, [captureLiveEditorSelection, restoreLiveEditorSelection, workspace]);

  const startPendingLiveCommentDraft = useCallback(() => {
    const range = pendingLiveEditCommentRangeRef.current;
    if (!range) return;
    const willOpenSidebar = !commentSidebarOpen;
    setCommentAddRange(range);
    liveSelectionDraftRangeRef.current = pendingLiveEditDomRangeRef.current ? pendingLiveEditDomRangeRef.current.cloneRange() : null;
    liveSelectionDraftTextRef.current = pendingLiveEditSelectedTextRef.current;
    setLiveSelectionDraftAnchor(pendingLiveEditCommentAnchorRef.current);
    setShowCommentInput(true);
    if (willOpenSidebar) setCommentSidebarOpen(true);
    hideLiveEditCommentButton();
    if (!willOpenSidebar) return;
    const refreshAnchor = () => {
      const liveRange = liveSelectionDraftRangeRef.current;
      const selectedText = liveSelectionDraftTextRef.current;
      if (!workspace.mdLiveRef.current) return;
      const textRange = selectedText
        ? findLiveEditTextRange(selectedText, countSourceOccurrencesBefore(selectedText, range.startLine, range.startChar))
        : null;
      const activeRange = textRange || liveRange;
      if (!activeRange || !workspace.mdLiveRef.current.contains(activeRange.startContainer) || !workspace.mdLiveRef.current.contains(activeRange.endContainer)) return;
      liveSelectionDraftRangeRef.current = activeRange.cloneRange();
      const next = getLiveSelectionDraftAnchor(activeRange);
      if (next) setLiveSelectionDraftAnchor(next);
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      refreshAnchor();
      window.setTimeout(refreshAnchor, 80);
    }));
  }, [commentSidebarOpen, countSourceOccurrencesBefore, findLiveEditTextRange, getLiveSelectionDraftAnchor, hideLiveEditCommentButton, setCommentAddRange, setCommentSidebarOpen, setShowCommentInput, workspace.mdLiveRef]);

  useEffect(() => {
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timerId) clearTimeout(timerId);
      timerId = setTimeout(() => liveEditSelectionRef.current(), 150);
    };
    document.addEventListener('selectionchange', handler);
    return () => {
      document.removeEventListener('selectionchange', handler);
      if (timerId) clearTimeout(timerId);
    };
  }, []);

  useEffect(() => {
    if (workspace.mdEditorMode !== 'live' || !workspace.mdSelectedFile || !isMarkdownFile(workspace.mdSelectedFile)) {
      setLiveCommentMarkers([]);
      return;
    }
    let frameId = 0;
    let trailingFrameId = 0;
    let trailingTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const computeMarkers = () => setLiveCommentMarkers(getLiveCommentMarkersForEditor());
    frameId = window.requestAnimationFrame(() => {
      computeMarkers();
      trailingFrameId = window.requestAnimationFrame(() => {
        computeMarkers();
        trailingTimeoutId = setTimeout(computeMarkers, 120);
      });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      window.cancelAnimationFrame(trailingFrameId);
      if (trailingTimeoutId != null) clearTimeout(trailingTimeoutId);
    };
  }, [fileComments, getLiveCommentMarkersForEditor, workspace.mdEditContent, workspace.mdEditorMode, workspace.mdLiveHtml, workspace.mdSelectedFile, selectedCommentId, commentSidebarOpen]);

  useEffect(() => {
    if (!showCommentInput || !liveSelectionDraftRangeRef.current) return;
    let outerFrameId = 0;
    let innerFrameId = 0;
    outerFrameId = window.requestAnimationFrame(() => {
      innerFrameId = window.requestAnimationFrame(() => {
        const range = liveSelectionDraftRangeRef.current;
        if (!workspace.mdLiveRef.current) return;
        const originalAttached = range && workspace.mdLiveRef.current.contains(range.startContainer) && workspace.mdLiveRef.current.contains(range.endContainer);
        const textRange = liveSelectionDraftTextRef.current && commentAddRange
          ? findLiveEditTextRange(liveSelectionDraftTextRef.current, countSourceOccurrencesBefore(liveSelectionDraftTextRef.current, commentAddRange.startLine, commentAddRange.startChar))
          : null;
        const activeRange = textRange || (originalAttached ? range : null);
        if (!activeRange || !workspace.mdLiveRef.current.contains(activeRange.startContainer) || !workspace.mdLiveRef.current.contains(activeRange.endContainer)) return;
        liveSelectionDraftRangeRef.current = activeRange.cloneRange();
        const anchor = getLiveSelectionDraftAnchor(activeRange);
        if (anchor) setLiveSelectionDraftAnchor(anchor);
      });
    });
    return () => {
      window.cancelAnimationFrame(outerFrameId);
      window.cancelAnimationFrame(innerFrameId);
    };
  }, [showCommentInput, commentSidebarOpen, commentAddRange, countSourceOccurrencesBefore, findLiveEditTextRange, getLiveSelectionDraftAnchor, workspace.mdLiveRef]);

  useLayoutEffect(() => {
    if (workspace.mdEditorMode !== 'live' || !workspace.mdLiveRef.current) return;
    if (workspace.mdLiveRef.current.innerHTML !== workspace.mdLiveHtml) {
      workspace.mdLiveRef.current.innerHTML = workspace.mdLiveHtml;
    }
  }, [workspace.mdLiveHtml, workspace.mdEditorMode, workspace.mdSelectedFile, workspace.mdLiveElementVersion, workspace.mdLiveRef]);

  useLayoutEffect(() => {
    const snapshot = pendingLiveEditorSelectionRef.current;
    if (!snapshot || workspace.mdEditorMode !== 'live') return;
    pendingLiveEditorSelectionRef.current = null;
    restoreLiveEditorSelection(snapshot);
  }, [restoreLiveEditorSelection, workspace.mdLiveHtml, workspace.mdEditorMode]);

  useEffect(() => {
    if (showCommentInput) return;
    if (!selectedCommentId || workspace.mdEditorMode !== 'live' || !workspace.mdSelectedFile || !isMarkdownFile(workspace.mdSelectedFile)) {
      clearLiveSelectionDraft();
      return;
    }
    const comment = fileComments.find(c => c.id === selectedCommentId);
    if (!comment) {
      clearLiveSelectionDraft();
      return;
    }
    let frameId = 0;
    frameId = window.requestAnimationFrame(() => {
      const range = getLiveEditRangeForComment(comment);
      if (!range) {
        clearLiveSelectionDraft();
        return;
      }
      liveSelectionDraftRangeRef.current = range.cloneRange();
      liveSelectionDraftTextRef.current = range.toString();
      const anchor = getLiveSelectionDraftAnchor(range);
      if (anchor) setLiveSelectionDraftAnchor(anchor);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [selectedCommentId, fileComments, workspace.mdEditorMode, workspace.mdSelectedFile, workspace.mdEditContent, showCommentInput, clearLiveSelectionDraft, getLiveEditRangeForComment, getLiveSelectionDraftAnchor]);

  return {
    liveSelectionDraftAnchor,
    setLiveSelectionDraftAnchor,
    liveCommentMarkers,
    fileContentRef,
    mdLiveContainerRef,
    liveEditCommentBtnRef,
    pendingLiveEditCommentRangeRef,
    pendingLiveEditCommentAnchorRef,
    pendingLiveEditDomRangeRef,
    pendingLiveEditSelectedTextRef,
    pendingLiveEditorSelectionRef,
    liveSelectionDraftRangeRef,
    liveSelectionDraftTextRef,
    recentLiveCommentAnchorsRef,
    liveEditSelectionRef,
    handleTextSelection,
    handleFileContentScroll,
    handleLiveEditorScroll,
    captureLiveEditorSelection,
    restoreLiveEditorSelection,
    clearLiveSelectionDraft,
    hideLiveEditCommentButton,
    findLiveEditTextRange,
    countSourceOccurrencesBefore,
    getCommentSourceText,
    getLiveEditRangeForComment,
    getLiveSelectionDraftAnchor,
    getLiveCommentMarkersForEditor,
    positionLiveEditCommentButton,
    handleLiveEditSelection,
    handleLiveEditableBeforeInput,
    handleLiveEditableInput,
    startPendingLiveCommentDraft,
  };
}
