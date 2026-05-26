'use client';

import { useEffect, useState } from 'react';

type FsDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

function getFsElement(): Element | null {
  if (typeof document === 'undefined') return null;
  const d = document as FsDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

function fsSupported(): boolean {
  if (typeof document === 'undefined') return false;
  const d = document as FsDoc;
  return Boolean(d.fullscreenEnabled || d.webkitFullscreenEnabled);
}

export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(fsSupported());
    const update = () => setIsFullscreen(getFsElement() !== null);
    update();
    document.addEventListener('fullscreenchange', update);
    document.addEventListener('webkitfullscreenchange', update as EventListener);
    return () => {
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('webkitfullscreenchange', update as EventListener);
    };
  }, []);

  const toggle = async () => {
    if (typeof document === 'undefined') return;
    const d = document as FsDoc;
    try {
      if (getFsElement()) {
        if (d.exitFullscreen) await d.exitFullscreen();
        else if (d.webkitExitFullscreen) await d.webkitExitFullscreen();
      } else {
        const el = document.documentElement as FsElement;
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
      }
    } catch {
      // Browser may reject (e.g., iPhone Safari); ignore.
    }
  };

  return { isFullscreen, supported, toggle };
}
