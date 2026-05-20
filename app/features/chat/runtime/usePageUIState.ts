'use client';

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { THEMES, normalizeThemeId, type ThemeId } from '../../theme/themes';
import { STORAGE_SIDEBAR_COLLAPSED, STORAGE_THEME } from './sessionPersistence';

export function usePageUIState({ mounted }: { mounted: boolean }) {
  const [themeId, setThemeIdState] = useState<ThemeId>('aurora');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const sidebarDragRef = useRef(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [showChatsPanel, setShowChatsPanel] = useState(false);
  const [openChatMenuId, setOpenChatMenuId] = useState<string | null>(null);
  const chatMenuButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);

  const normalizedThemeId = normalizeThemeId(themeId);
  const themeStyle = THEMES[normalizedThemeId].values as CSSProperties;

  function setThemeId(id: string) { setThemeIdState(normalizeThemeId(id) as ThemeId); }

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED);
      if (saved != null) setSidebarCollapsed(saved === '1');
    } catch { /* ignore */ }
    try {
      const savedTheme = window.localStorage.getItem(STORAGE_THEME);
      if (savedTheme) setThemeIdState(normalizeThemeId(savedTheme) as ThemeId);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed, mounted]);

  useEffect(() => {
    if (!mounted) return;
    window.localStorage.setItem(STORAGE_THEME, normalizedThemeId);
  }, [normalizedThemeId, mounted]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!sidebarDragRef.current) return;
      setSidebarWidth(Math.max(260, Math.min(600, e.clientX)));
    };
    const onMouseUp = () => {
      if (sidebarDragRef.current) {
        sidebarDragRef.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => { window.removeEventListener('mousemove', onMouseMove); window.removeEventListener('mouseup', onMouseUp); };
  }, []);

  useEffect(() => {
    if (!openChatMenuId) return;
    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (!target?.closest('.chatActionsWrap') && !target?.closest('.chatActionsMenu')) setOpenChatMenuId(null);
    }
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [openChatMenuId]);

  return {
    themeId, setThemeId, normalizedThemeId, themeStyle,
    sidebarCollapsed, setSidebarCollapsed, sidebarWidth, sidebarDragRef,
    lightboxImage, setLightboxImage,
    showChatsPanel, setShowChatsPanel,
    openChatMenuId, setOpenChatMenuId, chatMenuButtonRefs,
    renamingChatId, setRenamingChatId, renameValue, setRenameValue,
    mentionSelectedIndex, setMentionSelectedIndex,
  };
}
