'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { THEMES, normalizeThemeId } from '../../theme/themes';

export type PageHeaderProps = {
  authLabel: string;
  isAdmin: boolean;
  onSignOut: () => void;
  themeMenu: ReactNode;
  showChatsPanel: boolean;
  showAgentsPanel: boolean;
  showNodesPanel: boolean;
  onToggleChats: () => void;
  onToggleAgents: () => void;
  onToggleNodes: () => void;
  activeThemeId: string;
  normalizedThemeId: string;
  onSelectTheme: (id: string) => void;
};

export function PageHeader({
  authLabel,
  isAdmin,
  onSignOut,
  themeMenu,
  showChatsPanel,
  showAgentsPanel,
  showNodesPanel,
  onToggleChats,
  onToggleAgents,
  onToggleNodes,
  activeThemeId,
  normalizedThemeId,
  onSelectTheme,
}: PageHeaderProps) {
  const [showHeaderOverflow, setShowHeaderOverflow] = useState(false);
  const headerOverflowRef = useRef<HTMLDivElement | null>(null);
  const currentThemeId = normalizeThemeId(normalizedThemeId || activeThemeId);

  useEffect(() => {
    if (!showHeaderOverflow) return;
    function handlePointerDown(event: MouseEvent) {
      if (!headerOverflowRef.current?.contains(event.target as Node)) {
        setShowHeaderOverflow(false);
      }
    }
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [showHeaderOverflow]);

  return (
    <header className="header">
      <div className="headerLeft">
        <h1>🤖 Agents Chat</h1>
      </div>
      <div className="headerRight">
        <div className="headerInlineActions">
          <button className={`ghostButton mobileOnlyButton ${showChatsPanel ? 'activeGhost' : ''}`} onClick={onToggleChats} title="Chats">💬</button>
          {themeMenu}
          <button className={`ghostButton ${showAgentsPanel ? 'activeGhost' : ''}`} onClick={onToggleAgents} title="Agents">🤖</button>
          <button className={`ghostButton ${showNodesPanel ? 'activeGhost' : ''}`} onClick={onToggleNodes} title="Nodes">🖥️</button>
        </div>
        <div className="headerOverflowWrap" ref={headerOverflowRef}>
          <button
            type="button"
            className={`ghostButton headerOverflowBtn ${showHeaderOverflow ? 'activeGhost' : ''}`}
            onClick={() => setShowHeaderOverflow((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={showHeaderOverflow}
            aria-label="More actions"
            title="More"
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {showHeaderOverflow && (
            <div className="headerOverflowMenu" role="menu" aria-label="Header actions">
              <button
                type="button"
                role="menuitem"
                className={`headerOverflowItem ${showChatsPanel ? 'active' : ''}`}
                onClick={() => { onToggleChats(); setShowHeaderOverflow(false); }}
              >
                <span className="headerOverflowEmoji">💬</span>
                <span>Chats</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={`headerOverflowItem ${showAgentsPanel ? 'active' : ''}`}
                onClick={() => { onToggleAgents(); setShowHeaderOverflow(false); }}
              >
                <span className="headerOverflowEmoji">🤖</span>
                <span>Agents</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className={`headerOverflowItem ${showNodesPanel ? 'active' : ''}`}
                onClick={() => { onToggleNodes(); setShowHeaderOverflow(false); }}
              >
                <span className="headerOverflowEmoji">🖥️</span>
                <span>Nodes</span>
              </button>
              <div className="headerOverflowSeparator" />
              <div className="headerOverflowSectionLabel">Theme</div>
              {Object.entries(THEMES).map(([id, theme]) => (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={currentThemeId === id}
                  className={`headerOverflowItem ${currentThemeId === id ? 'active' : ''}`}
                  onClick={() => { onSelectTheme(id); setShowHeaderOverflow(false); }}
                >
                  <span className="headerOverflowEmoji">{theme.emoji}</span>
                  <span>{theme.label}</span>
                  {currentThemeId === id ? <span className="headerOverflowCheck">✓</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
        {authLabel && (
          <div className="userChip">
            <span className="userAvatar">{(authLabel || '?')[0].toUpperCase()}</span>
            <span className="userName">{authLabel}{isAdmin ? ' ★' : ''}</span>
            <button className="logoutBtn" onClick={onSignOut} title="Sign out">↗</button>
          </div>
        )}
      </div>
    </header>
  );
}
