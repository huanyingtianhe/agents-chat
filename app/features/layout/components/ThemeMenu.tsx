'use client';

import { useEffect, useRef, useState } from 'react';
import { THEMES, normalizeThemeId, type ThemeId } from '../../theme/themes';

export type ThemeMenuProps = {
  activeThemeId: string;
  onSelectTheme: (id: string) => void;
};

export function ThemeMenu({ activeThemeId, onSelectTheme }: ThemeMenuProps) {
  const [showMenu, setShowMenu] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const normalizedThemeId = normalizeThemeId(activeThemeId);
  const activeTheme = THEMES[normalizedThemeId];

  useEffect(() => {
    if (!showMenu) return;
    function handlePointerDown(event: MouseEvent) {
      if (!themeMenuRef.current?.contains(event.target as Node)) {
        setShowMenu(false);
      }
    }
    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [showMenu]);

  return (
    <div className="themeMenuWrap" ref={themeMenuRef}>
      <button
        type="button"
        className={`ghostButton themeMenuButton ${showMenu ? 'activeGhost' : ''}`}
        onClick={() => setShowMenu((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={showMenu}
        title={`Theme: ${activeTheme.label}`}
      >
        <span>{activeTheme.emoji}</span>
      </button>
      {showMenu && (
        <div className="themeDropdown" role="menu" aria-label="Theme list">
          {Object.entries(THEMES).map(([id, theme]) => (
            <button
              key={id}
              type="button"
              role="menuitemradio"
              aria-checked={normalizedThemeId === id}
              className={`themeOption ${normalizedThemeId === id ? 'activeThemeOption' : ''}`}
              onClick={() => {
                onSelectTheme(id as ThemeId);
                setShowMenu(false);
              }}
            >
              <span className="themeOptionMain">
                <span className="themeChipEmoji">{theme.emoji}</span>
                <span>{theme.label}</span>
              </span>
              {normalizedThemeId === id ? <span className="themeCheck">✓</span> : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
