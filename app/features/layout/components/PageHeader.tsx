'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { THEMES, normalizeThemeId } from '../../theme/themes';
import type { MobileOverlay } from '../hooks/useMobileOverlayState';
import { useFullscreen } from '../useFullscreen';

type ActiveMobileOverlay = Exclude<MobileOverlay, null>;

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
  onToggleChats: (trigger?: HTMLElement) => void;
  onToggleAgents: (trigger?: HTMLElement) => void;
  onToggleNodes: (trigger?: HTMLElement) => void;
  onToggleSchedules: (trigger?: HTMLElement) => void;
  activeThemeId: string;
  normalizedThemeId: string;
  onSelectTheme: (id: string) => void;
  lastUsedAgentScope: 'user' | 'chat';
  onSelectLastUsedAgentScope: (scope: 'user' | 'chat') => void;
  mobileOverlay: MobileOverlay;
  isMobileLayout: boolean;
  onMobileOverlayOpen: (overlay: ActiveMobileOverlay, trigger?: HTMLElement) => void;
  onMobileOverlayToggle: (overlay: ActiveMobileOverlay, trigger?: HTMLElement) => void;
  onMobileOverlayClose: () => void;
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
  mobileOverlay,
  isMobileLayout,
  onMobileOverlayOpen,
  onMobileOverlayToggle,
  onMobileOverlayClose,
}: PageHeaderProps) {
  const [showHeaderOverflow, setShowHeaderOverflow] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const headerOverflowRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const accountRef = useRef<HTMLDivElement | null>(null);
  const currentThemeId = normalizeThemeId(normalizedThemeId || activeThemeId);
  const { isFullscreen, supported: fullscreenSupported, toggle: toggleFullscreen } = useFullscreen();
  const overflowOpen = isMobileLayout ? mobileOverlay === 'more' : showHeaderOverflow;
  const settingsOpen = isMobileLayout ? mobileOverlay === 'settings' : showSettings;
  const accountOpen = isMobileLayout ? mobileOverlay === 'account' : showAccount;

  useEffect(() => {
    if (!showHeaderOverflow || isMobileLayout) return;
    function handlePointerDown(event: MouseEvent) {
      if (!headerOverflowRef.current?.contains(event.target as Node)) setShowHeaderOverflow(false);
    }
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMobileLayout, showHeaderOverflow]);

  useEffect(() => {
    if (!showSettings || isMobileLayout) return;
    function handlePointerDown(event: MouseEvent) {
      if (!settingsRef.current?.contains(event.target as Node)) setShowSettings(false);
    }
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMobileLayout, showSettings]);

  useEffect(() => {
    if (!showAccount || isMobileLayout) return;
    function handlePointerDown(event: MouseEvent) {
      if (!accountRef.current?.contains(event.target as Node)) setShowAccount(false);
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
  }, [isMobileLayout, showAccount]);

  const selectScope = (scope: 'user' | 'chat') => {
    onSelectLastUsedAgentScope(scope);
    if (isMobileLayout) onMobileOverlayClose();
    else setShowSettings(false);
  };

  const selectTheme = (id: string) => {
    onSelectTheme(id);
    if (isMobileLayout) onMobileOverlayClose();
    else setShowHeaderOverflow(false);
  };

  const settingsItems = (
    <>
      <div className="headerOverflowSectionLabel">Remember last @-mentioned agent</div>
      <button type="button" role="menuitemradio" aria-checked={lastUsedAgentScope === 'user'} className={`headerOverflowItem ${lastUsedAgentScope === 'user' ? 'active' : ''}`} onClick={() => selectScope('user')}>
        <span className="headerOverflowEmoji">👤</span><span>Per user (all chats)</span>
        {lastUsedAgentScope === 'user' ? <span className="headerOverflowCheck">✓</span> : null}
      </button>
      <button type="button" role="menuitemradio" aria-checked={lastUsedAgentScope === 'chat'} className={`headerOverflowItem ${lastUsedAgentScope === 'chat' ? 'active' : ''}`} onClick={() => selectScope('chat')}>
        <span className="headerOverflowEmoji">💬</span><span>Per chat</span>
        {lastUsedAgentScope === 'chat' ? <span className="headerOverflowCheck">✓</span> : null}
      </button>
    </>
  );

  const themeItems = Object.entries(THEMES).map(([id, theme]) => (
    <button key={id} type="button" role="menuitemradio" aria-checked={currentThemeId === id} className={`headerOverflowItem ${currentThemeId === id ? 'active' : ''}`} onClick={() => selectTheme(id)}>
      <span className="headerOverflowEmoji">{theme.emoji}</span><span>{theme.label}</span>
      {currentThemeId === id ? <span className="headerOverflowCheck">✓</span> : null}
    </button>
  ));

  return (
    <header className="header">
      <div className="headerLeft">
        <button
          type="button"
          className="ghostButton mobileNavigationButton"
          aria-label={mobileOverlay === 'navigation' ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileOverlay === 'navigation'}
          onClick={(event) => onToggleChats(event.currentTarget)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <h1>🤖 Agents Chat</h1>
      </div>
      <div className="headerRight">
        <div className="headerInlineActions">
          {themeMenu}
          <button className={`ghostButton ${showAgentsPanel ? 'activeGhost' : ''}`} onClick={() => onToggleAgents()} title="Agents">🤖</button>
          <button className={`ghostButton ${showNodesPanel ? 'activeGhost' : ''}`} onClick={() => onToggleNodes()} title="Nodes">🖥️</button>
          <button className={`ghostButton ${showSchedulesPanel ? 'activeGhost' : ''}`} onClick={() => onToggleSchedules()} title="Schedules">⏰</button>
          {fullscreenSupported && (
            <button className={`ghostButton ${isFullscreen ? 'activeGhost' : ''}`} onClick={() => void toggleFullscreen()} title={isFullscreen ? 'Exit full screen' : 'Enter full screen'} aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'} aria-pressed={isFullscreen}>
              {isFullscreen ? '🗗' : '⛶'}
            </button>
          )}
          <div className="headerSettingsWrap" ref={settingsRef}>
            <button type="button" className={`ghostButton ${settingsOpen ? 'activeGhost' : ''}`} onClick={() => setShowSettings((value) => !value)} aria-haspopup="menu" aria-expanded={settingsOpen} aria-label="Settings" title="Settings">
              <span aria-hidden="true">⚙️</span>
            </button>
            {!isMobileLayout && settingsOpen ? <div className="headerOverflowMenu" role="menu" aria-label="Settings">{settingsItems}</div> : null}
          </div>
        </div>

        <div className="headerOverflowWrap" ref={headerOverflowRef}>
          <button
            type="button"
            className={`ghostButton headerOverflowBtn ${overflowOpen ? 'activeGhost' : ''}`}
            onClick={(event) => {
              if (isMobileLayout) onMobileOverlayToggle('more', event.currentTarget);
              else setShowHeaderOverflow((value) => !value);
            }}
            aria-haspopup="menu"
            aria-expanded={overflowOpen}
            aria-label="More actions"
            title="More"
          >
            <span aria-hidden="true">⋯</span>
          </button>
          {overflowOpen && (
            <div className="headerOverflowMenu" role="menu" aria-label="Header actions">
              {isMobileLayout ? (
                <>
                  <button type="button" role="menuitem" className="headerOverflowItem" onClick={(event) => onMobileOverlayOpen('theme', event.currentTarget)}><span className="headerOverflowEmoji">🎨</span><span>Theme</span></button>
                  <button type="button" role="menuitem" className={`headerOverflowItem ${showAgentsPanel ? 'active' : ''}`} onClick={(event) => onToggleAgents(event.currentTarget)}><span className="headerOverflowEmoji">🤖</span><span>Agents</span></button>
                  <button type="button" role="menuitem" className={`headerOverflowItem ${showNodesPanel ? 'active' : ''}`} onClick={(event) => onToggleNodes(event.currentTarget)}><span className="headerOverflowEmoji">🖥️</span><span>Nodes</span></button>
                  <button type="button" role="menuitem" className={`headerOverflowItem ${showSchedulesPanel ? 'active' : ''}`} onClick={(event) => onToggleSchedules(event.currentTarget)}><span className="headerOverflowEmoji">⏰</span><span>Schedules</span></button>
                  <button type="button" role="menuitem" className="headerOverflowItem" onClick={(event) => onMobileOverlayOpen('settings', event.currentTarget)}><span className="headerOverflowEmoji">⚙️</span><span>Settings</span></button>
                </>
              ) : (
                <>
                  <button type="button" role="menuitem" className={`headerOverflowItem ${showChatsPanel ? 'active' : ''}`} onClick={() => { onToggleChats(); setShowHeaderOverflow(false); }}><span className="headerOverflowEmoji">💬</span><span>Chats</span></button>
                  <button type="button" role="menuitem" className={`headerOverflowItem ${showAgentsPanel ? 'active' : ''}`} onClick={() => { onToggleAgents(); setShowHeaderOverflow(false); }}><span className="headerOverflowEmoji">🤖</span><span>Agents</span></button>
                  <button type="button" role="menuitem" className={`headerOverflowItem ${showNodesPanel ? 'active' : ''}`} onClick={() => { onToggleNodes(); setShowHeaderOverflow(false); }}><span className="headerOverflowEmoji">🖥️</span><span>Nodes</span></button>
                  <button type="button" role="menuitem" className={`headerOverflowItem ${showSchedulesPanel ? 'active' : ''}`} onClick={() => { onToggleSchedules(); setShowHeaderOverflow(false); }}><span className="headerOverflowEmoji">⏰</span><span>Schedules</span></button>
                  {fullscreenSupported ? <button type="button" role="menuitem" className={`headerOverflowItem ${isFullscreen ? 'active' : ''}`} onClick={() => { void toggleFullscreen(); setShowHeaderOverflow(false); }}><span className="headerOverflowEmoji">{isFullscreen ? '🗗' : '⛶'}</span><span>{isFullscreen ? 'Exit full screen' : 'Full screen'}</span></button> : null}
                  <div className="headerOverflowSeparator" />
                  {settingsItems}
                  <div className="headerOverflowSeparator" />
                  <div className="headerOverflowSectionLabel">Theme</div>
                  {themeItems}
                </>
              )}
            </div>
          )}
          {isMobileLayout && mobileOverlay === 'theme' ? (
            <div className="headerOverflowMenu mobileHeaderSubmenu" role="menu" aria-label="Theme">
              <button type="button" role="menuitem" className="headerOverflowItem" onClick={() => onMobileOverlayOpen('more')}><span className="headerOverflowEmoji">←</span><span>Back</span></button>
              <div className="headerOverflowSeparator" />
              {themeItems}
            </div>
          ) : null}
          {isMobileLayout && mobileOverlay === 'settings' ? (
            <div className="headerOverflowMenu mobileHeaderSubmenu" role="menu" aria-label="Settings">
              <button type="button" role="menuitem" className="headerOverflowItem" onClick={() => onMobileOverlayOpen('more')}><span className="headerOverflowEmoji">←</span><span>Back</span></button>
              <div className="headerOverflowSeparator" />
              {settingsItems}
            </div>
          ) : null}
        </div>

        {authLabel && (
          <div className="userChip" ref={accountRef}>
            {userImage ? <img className="userAvatar userAvatarImage" src={userImage} alt="" /> : <span className="userAvatar">{(authLabel || '?')[0].toUpperCase()}</span>}
            <button
              type="button"
              className="userName userNameButton"
              onClick={(event) => {
                if (isMobileLayout) onMobileOverlayToggle('account', event.currentTarget);
                else setShowAccount((value) => !value);
              }}
              aria-haspopup="dialog"
              aria-expanded={accountOpen}
              aria-label={`Account details for ${authLabel}`}
              title="View account details"
            >
              {authLabel}{isAdmin ? ' ★' : ''}
            </button>
            {accountOpen && (
              <div className="accountMenu" role="dialog" aria-label="Account details">
                <div className="accountMenuHeader">
                  {userImage ? <img className="accountMenuAvatar" src={userImage} alt="" /> : <span className="accountMenuAvatar accountMenuAvatarFallback">{(authLabel || '?')[0].toUpperCase()}</span>}
                  <div className="accountMenuIdentity"><span className="accountMenuName">{authLabel}</span><span className={`accountMenuRole ${isAdmin ? 'isAdmin' : ''}`}>{isAdmin ? '★ Administrator' : 'User'}</span></div>
                </div>
                <div className="accountMenuRow"><span className="accountMenuLabel">Name</span><span className="accountMenuValue">{authLabel}</span></div>
                <div className="accountMenuRow"><span className="accountMenuLabel">Email</span><span className="accountMenuValue">{userEmail || '—'}</span></div>
                <div className="accountMenuRow"><span className="accountMenuLabel">Role</span><span className="accountMenuValue">{isAdmin ? 'Administrator' : 'User'}</span></div>
                <div className="accountMenuSeparator" />
                <button type="button" className="accountMenuSignOut" onClick={() => { if (isMobileLayout) onMobileOverlayClose(); else setShowAccount(false); onSignOut(); }}>Sign out</button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
