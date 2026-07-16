'use client';

import { useEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';

export type ChatShellProps = {
  sidebar: ReactNode;
  header: ReactNode;
  messages: ReactNode;
  composer: ReactNode;
  rightPanel: ReactNode | null;
  statusBar: ReactNode;
  shareDialog: ReactNode | null;
  imageLightbox: ReactNode | null;
  workflowPicker?: ReactNode | null;
  mobilePanel: 'chat' | 'agents' | 'nodes' | 'schedules' | null;
  onMobilePanelChange: (panel: 'chat' | 'agents' | 'nodes' | 'schedules' | null) => void;
  themeStyle: CSSProperties;
  themeId: string;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  agentsSidebarOpen: boolean;
  onSidebarResizeStart: (e: MouseEvent<HTMLDivElement>) => void;
};

export function ChatShell({
  sidebar,
  header,
  messages,
  composer,
  rightPanel,
  statusBar,
  shareDialog,
  imageLightbox,
  workflowPicker,
  mobilePanel,
  onMobilePanelChange,
  themeStyle,
  themeId,
  sidebarWidth,
  sidebarCollapsed,
  agentsSidebarOpen,
  onSidebarResizeStart,
}: ChatShellProps) {
  const pageRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;

    const visualViewport = window.visualViewport;
    const syncViewport = () => {
      const height = visualViewport?.height ?? window.innerHeight;
      const offsetTop = visualViewport?.offsetTop ?? 0;
      page.style.setProperty('--app-viewport-height', `${Math.round(height)}px`);
      page.style.setProperty('--app-viewport-offset-top', `${Math.round(offsetTop)}px`);
    };

    syncViewport();
    window.addEventListener('resize', syncViewport);
    window.addEventListener('orientationchange', syncViewport);
    visualViewport?.addEventListener('resize', syncViewport);
    visualViewport?.addEventListener('scroll', syncViewport);
    return () => {
      window.removeEventListener('resize', syncViewport);
      window.removeEventListener('orientationchange', syncViewport);
      visualViewport?.removeEventListener('resize', syncViewport);
      visualViewport?.removeEventListener('scroll', syncViewport);
    };
  }, []);

  return (
    <main ref={pageRef} className="page" style={themeStyle} data-theme={themeId} suppressHydrationWarning>
      {header}
      {mobilePanel !== null && (
        <div className="mobilePanelBackdrop" onClick={() => onMobilePanelChange(null)} />
      )}
      <div
        className={`chatLayout${sidebarCollapsed ? ' sidebarCollapsed' : ''}${agentsSidebarOpen ? ' agentsSidebarOpen' : ''}`}
        style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      >
        {sidebar}
        {!sidebarCollapsed && (
          <div className="sidebarResizeHandle" onMouseDown={onSidebarResizeStart} />
        )}
        <div className="chatMain">
          {messages}
          {composer}
        </div>
        {rightPanel}
      </div>
      {shareDialog}
      {imageLightbox}
      {workflowPicker}
      {statusBar}
    </main>
  );
}
