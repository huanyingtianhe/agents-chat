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

  const close = useCallback((fromHistory = false) => {
    setActiveOverlay(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    queueMicrotask(() => trigger?.isConnected && trigger.focus());
    if (historyEntryRef.current && !fromHistory) {
      historyEntryRef.current = false;
      window.history.back();
    }
  }, []);

  const open = useCallback((overlay: ActiveMobileOverlay, trigger?: HTMLElement) => {
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
    if (!isMobileLayout || activeOverlay === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onPopState = () => {
      historyEntryRef.current = false;
      close(true);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('popstate', onPopState);
    };
  }, [activeOverlay, close, isMobileLayout]);

  return { activeOverlay, isMobileLayout, open, toggle, close };
}
