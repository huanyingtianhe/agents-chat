'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const MOBILE_LAYOUT_QUERY = '(max-width: 900px)';

export type MobileOverlay =
  | 'navigation'
  | 'more'
  | 'theme'
  | 'agents'
  | 'nodes'
  | 'schedules'
  | 'settings'
  | 'account'
  | null;

type ActiveMobileOverlay = Exclude<MobileOverlay, null>;

export function useMobileOverlayState() {
  const [isMobileLayout, setIsMobileLayout] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState<MobileOverlay>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const historyEntryRef = useRef(false);
  const historyClosePendingRef = useRef(false);
  const pendingOpenRef = useRef<{ overlay: ActiveMobileOverlay; trigger?: HTMLElement } | null>(null);

  const close = useCallback((fromHistory = false) => {
    setActiveOverlay(null);
    document.body.style.overflow = '';
    if (!fromHistory) {
      if (historyEntryRef.current && !historyClosePendingRef.current) {
        historyClosePendingRef.current = true;
        window.history.back();
      }
      if (historyClosePendingRef.current) return;
    }
    const trigger = triggerRef.current;
    triggerRef.current = null;
    queueMicrotask(() => trigger?.isConnected && trigger.focus());
  }, []);

  const open = useCallback((overlay: ActiveMobileOverlay, trigger?: HTMLElement) => {
    if (historyClosePendingRef.current) {
      pendingOpenRef.current = { overlay, trigger };
      return;
    }
    if (trigger) triggerRef.current = trigger;
    if (!historyEntryRef.current) {
      window.history.pushState({ agentsChatMobileOverlay: true }, '');
      historyEntryRef.current = true;
    }
    setActiveOverlay(overlay);
  }, []);

  const toggle = useCallback((overlay: ActiveMobileOverlay, trigger?: HTMLElement) => {
    if (activeOverlay === overlay) close();
    else open(overlay, trigger);
  }, [activeOverlay, close, open]);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_LAYOUT_QUERY);
    const sync = () => setIsMobileLayout(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    if (isMobileLayout || activeOverlay === null) return;
    close();
  }, [activeOverlay, close, isMobileLayout]);

  useEffect(() => {
    if (!isMobileLayout) return;
    if (activeOverlay === null) {
      document.body.style.overflow = '';
      return;
    }
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = '';
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeOverlay, close, isMobileLayout]);

  useEffect(() => {
    const onPopState = () => {
      if (!historyEntryRef.current && !historyClosePendingRef.current) return;
      const pendingOpen = pendingOpenRef.current;
      pendingOpenRef.current = null;
      historyEntryRef.current = false;
      historyClosePendingRef.current = false;
      close(true);
      if (pendingOpen) queueMicrotask(() => open(pendingOpen.overlay, pendingOpen.trigger));
    };
    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, [close, open]);

  return { activeOverlay, isMobileLayout, open, toggle, close };
}
