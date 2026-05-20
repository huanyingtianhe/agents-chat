'use client';

import type { CSSProperties, MouseEvent, ReactNode } from 'react';

export type ChatShellProps = {
  sidebar: ReactNode;
  header: ReactNode;
  messages: ReactNode;
  composer: ReactNode;
  rightPanel: ReactNode | null;
  statusBar: ReactNode;
  shareDialog: ReactNode | null;
  imageLightbox: ReactNode | null;
  mobilePanel: 'chat' | 'agents' | 'nodes' | null;
  onMobilePanelChange: (panel: 'chat' | 'agents' | 'nodes' | null) => void;
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
  mobilePanel,
  onMobilePanelChange,
  themeStyle,
  themeId,
  sidebarWidth,
  sidebarCollapsed,
  agentsSidebarOpen,
  onSidebarResizeStart,
}: ChatShellProps) {
  return (
    <main className="page" style={themeStyle} data-theme={themeId} suppressHydrationWarning>
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
      {statusBar}
    </main>
  );
}
