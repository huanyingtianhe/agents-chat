'use client';

import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import type { ChatAttachment } from '../../composer/attachmentTypes';
import { filesToAttachments } from '../../composer/attachmentHelpers';
import { STORAGE_CHAT_INPUT } from './sessionPersistence';

export function useComposerState() {
  const [input, setInput] = useState('');
  const inputRef = useRef('');
  const inputDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputHistoryIndexRef = useRef(-1);
  const inputDraftRef = useRef('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingAttachment, setIsDraggingAttachment] = useState(false);
  const [mounted, setMounted] = useState(false);

  const resizeComposer = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.overflowY = 'hidden';
    const next = Math.min(Math.max(el.scrollHeight, 28), 300);
    el.style.height = `${next}px`;
    if (el.scrollHeight > 300) el.style.overflowY = 'auto';
  }, []);

  const setInputProgrammatic = useCallback((value: string) => {
    inputRef.current = value;
    if (inputDebounceRef.current) clearTimeout(inputDebounceRef.current);
    setInput(value);
    if (composerRef.current) {
      composerRef.current.value = value;
      resizeComposer();
    }
  }, [resizeComposer]);

  const composerInputHandler = useCallback(() => {
    const el = composerRef.current;
    if (!el) return;
    inputRef.current = el.value;
    resizeComposer();
    if (inputDebounceRef.current) clearTimeout(inputDebounceRef.current);
    inputDebounceRef.current = setTimeout(() => {
      startTransition(() => setInput(composerRef.current?.value || ''));
    }, 300);
  }, [resizeComposer]);

  async function addFilesToComposer(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter(Boolean);
    if (!files.length) return;
    try {
      const result = await filesToAttachments(files, attachments);
      if (result.error) { setAttachmentError(result.error); return; }
      setAttachments(prev => [...prev, ...result.attachments]);
      setAttachmentError(null);
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'Failed to read attachment.');
    }
  }

  function removeAttachment(id: string) { setAttachments(prev => prev.filter(a => a.id !== id)); setAttachmentError(null); }
  function clearAttachments() { setAttachments([]); setAttachmentError(null); }

  function getFilesFromClipboard(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
    const files: File[] = [];
    const seen = new Set<string>();
    const addFile = (file: File | null) => {
      if (!file) return;
      const key = `${file.name.trim().toLowerCase()}:${file.size}:${file.type.trim().toLowerCase()}`;
      if (!seen.has(key)) { seen.add(key); files.push(file); }
    };
    const clipFiles = Array.from(event.clipboardData.files || []);
    if (clipFiles.length) clipFiles.forEach(addFile);
    else Array.from(event.clipboardData.items || []).forEach(item => { if (item.kind === 'file') addFile(item.getAsFile()); });
    return files;
  }

  function handleAttachmentPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = getFilesFromClipboard(event);
    if (!files.length) return;
    event.preventDefault();
    void addFilesToComposer(files);
  }

  function dataTransferHasFiles(event: DragEvent<HTMLElement>) { return Array.from(event.dataTransfer.types || []).includes('Files'); }
  function handleComposerDragOver(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event)) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setIsDraggingAttachment(true);
  }
  function handleComposerDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingAttachment(false);
  }
  function handleComposerDrop(event: DragEvent<HTMLDivElement>) {
    if (!dataTransferHasFiles(event)) return;
    event.preventDefault(); setIsDraggingAttachment(false); void addFilesToComposer(event.dataTransfer.files);
  }

  useEffect(() => {
    setMounted(true);
    const savedInput = window.localStorage.getItem(STORAGE_CHAT_INPUT);
    if (savedInput) setInputProgrammatic(savedInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(STORAGE_CHAT_INPUT, input);
  }, [input, mounted]);

  return {
    input, inputRef, composerRef, fileInputRef, inputHistoryIndexRef, inputDraftRef,
    attachments, attachmentError, isDraggingAttachment, mounted, setInputProgrammatic,
    composerInputHandler, addFilesToComposer, removeAttachment, clearAttachments,
    handleAttachmentPaste, handleComposerDragOver, handleComposerDragLeave, handleComposerDrop,
  };
}
