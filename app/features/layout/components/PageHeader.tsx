'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { THEMES, normalizeThemeId } from '../../theme/themes';
import { useFullscreen } from '../useFullscreen';

export type PageHeaderProps = {
  authLabel: string;
  isAdmin: boolean;
  userEmail?: string | null;
  userImage?: string | null;
  onSignOut: () => void;
  themeMenu: ReactNode;
  showChatsPanel: boolean;
  showAgentsPanel: boolean;
  showNodesPanel: boolean;
  showSchedulesPanel: boolean;
  onToggleChats: () => void;
  onToggleAgents: () => void;
  onToggleNodes: () => void;
  onToggleSchedules: () => void;
  activeThemeId: string;
  normalizedThemeId: string;
  onSelectTheme: (id: string) => void;
  lastUsedAgentScope: 'user' | 'chat';
  onSelectLastUsedAgentScope: (scope: 'user' | 'chat') => void;
};

export function PageHeader({
  authLabel,
  isAdmin,
  userEmail,
  userImage,
  onSignOut,
  themeMenu,
  showChatsPanel,
  showAgentsPanel,
  showNodesPanel,
  showSchedulesPanel,
  onToggleChats,
  onToggleAgents,
  onToggleNodes,
  onToggleSchedules,
  activeThemeId,
  normalizedThemeId,
  onSelectTheme,
  lastUsedAgentScope,
  onSelectLastUsedAgentScope,
}: PageHeaderProps) {
  const [showHeaderOverflow, setShowHeaderOverflow] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const headerOverflowRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const accountRef = useRef<HTMLDivElement | null>(null);
  const currentThemeId = normalizeThemeId(normalizedThemeId || activeThemeId);
  const { isFullscreen, supported: fullscreenSupported, toggle: toggleFullscreen } = useFullscreen();

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

  useEffect(() => {
    if (!showSettings) return;
    function handlePointerDown(event: MouseEvent) {
      if (!settingsRef.current?.contains(event.target as Node)) {
        setShowSettings(false);
      }
    }
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [showSettings]);

  useEffect(() => {
    if (!showAccount) return;
    function handlePointerDown(event: MouseEvent) {
      if (!accountRef.current?.contains(event.target as Node)) {
        setShowAccount(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setShowAccount(false);
    }
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showAccount]);

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
          <button className={`ghostButton ${showSchedulesPanel ? 'activeGhost' : ''}`} onClick={onToggleSchedules} title="Schedules">⏰</button>
          {fullscreenSupported && (
            <button
              className={`ghostButton ${isFullscreen ? 'activeGhost' : ''}`}
              onClick={() => void toggleFullscreen()}
              title={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
              aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? '🗗' : '⛶'}
            </button>
          )}
          <div className="headerSettingsWrap" ref={settingsRef}>
            <button
              type="button"
              className={`ghostButton ${showSettings ? 'activeGhost' : ''}`}
              onClick={() => setShowSettings((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={showSettings}
              aria-label="Settings"
              title="Settings"
            >
              <span aria-hidden="true">⚙️</span>
            </button>
            {showSettings && (
              <div className="headerOverflowMenu" role="menu" aria-label="Settings">
                <div className="headerOverflowSectionLabel">Remember last @-mentioned agent</div>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={lastUsedAgentScope === 'user'}
                  className={`headerOverflowItem ${lastUsedAgentScope === 'user' ? 'active' : ''}`}
                  onClick={() => { onSelectLastUsedAgentScope('user'); setShowSettings(false); }}
                >
                  <span className="headerOverflowEmoji">👤</span>
                  <span>Per user (all chats)</span>
                  {lastUsedAgentScope === 'user' ? <span className="headerOverflowCheck">✓</span> : null}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={lastUsedAgentScope === 'chat'}
                  className={`headerOverflowItem ${lastUsedAgentScope === 'chat' ? 'active' : ''}`}
                  onClick={() => { onSelectLastUsedAgentScope('chat'); setShowSettings(false); }}
                >
                  <span className="headerOverflowEmoji">💬</span>
                  <span>Per chat</span>
                  {lastUsedAgentScope === 'chat' ? <span className="headerOverflowCheck">✓</span> : null}
                </button>
              </div>
            )}
          </div>
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
              <button
                type="button"
                role="menuitem"
                className={`headerOverflowItem ${showSchedulesPanel ? 'active' : ''}`}
                onClick={() => { onToggleSchedules(); setShowHeaderOverflow(false); }}
              >
                <span className="headerOverflowEmoji">⏰</span>
                <span>Schedules</span>
              </button>
              {fullscreenSupported && (
                <button
                  type="button"
                  role="menuitem"
                  className={`headerOverflowItem ${isFullscreen ? 'active' : ''}`}
                  onClick={() => { void toggleFullscreen(); setShowHeaderOverflow(false); }}
                >
                  <span className="headerOverflowEmoji">{isFullscreen ? '🗗' : '⛶'}</span>
                  <span>{isFullscreen ? 'Exit full screen' : 'Full screen'}</span>
                </button>
              )}
              <div className="headerOverflowSeparator" />
              <div className="headerOverflowSectionLabel">Remember last @-mentioned agent</div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={lastUsedAgentScope === 'user'}
                className={`headerOverflowItem ${lastUsedAgentScope === 'user' ? 'active' : ''}`}
                onClick={() => { onSelectLastUsedAgentScope('user'); setShowHeaderOverflow(false); }}
              >
                <span className="headerOverflowEmoji">👤</span>
                <span>Per user (all chats)</span>
                {lastUsedAgentScope === 'user' ? <span className="headerOverflowCheck">✓</span> : null}
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={lastUsedAgentScope === 'chat'}
                className={`headerOverflowItem ${lastUsedAgentScope === 'chat' ? 'active' : ''}`}
                onClick={() => { onSelectLastUsedAgentScope('chat'); setShowHeaderOverflow(false); }}
              >
                <span className="headerOverflowEmoji">💬</span>
                <span>Per chat</span>
                {lastUsedAgentScope === 'chat' ? <span className="headerOverflowCheck">✓</span> : null}
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
          <div className="userChip" ref={accountRef}>
            {userImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="userAvatar userAvatarImage" src={userImage} alt="" />
            ) : (
              <span className="userAvatar">{(authLabel || '?')[0].toUpperCase()}</span>
            )}
            <button
              type="button"
              className="userName userNameButton"
              onClick={() => setShowAccount((v) => !v)}
              aria-haspopup="dialog"
              aria-expanded={showAccount}
              title="View account details"
            >
              {authLabel}{isAdmin ? ' ★' : ''}
            </button>
            <button className="logoutBtn" onClick={onSignOut} title="Sign out">↗</button>
            {showAccount && (
              <div className="accountMenu" role="dialog" aria-label="Account details">
                <div className="accountMenuHeader">
                  {userImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="accountMenuAvatar" src={userImage} alt="" />
                  ) : (
                    <span className="accountMenuAvatar accountMenuAvatarFallback">{(authLabel || '?')[0].toUpperCase()}</span>
                  )}
                  <div className="accountMenuIdentity">
                    <span className="accountMenuName">{authLabel}</span>
                    <span className={`accountMenuRole ${isAdmin ? 'isAdmin' : ''}`}>{isAdmin ? '★ Administrator' : 'User'}</span>
                  </div>
                </div>
                <div className="accountMenuRow">
                  <span className="accountMenuLabel">Name</span>
                  <span className="accountMenuValue">{authLabel}</span>
                </div>
                <div className="accountMenuRow">
                  <span className="accountMenuLabel">Email</span>
                  <span className="accountMenuValue">{userEmail || '—'}</span>
                </div>
                <div className="accountMenuRow">
                  <span className="accountMenuLabel">Role</span>
                  <span className="accountMenuValue">{isAdmin ? 'Administrator' : 'User'}</span>
                </div>
                <div className="accountMenuSeparator" />
                <button type="button" className="accountMenuSignOut" onClick={() => { setShowAccount(false); onSignOut(); }}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
