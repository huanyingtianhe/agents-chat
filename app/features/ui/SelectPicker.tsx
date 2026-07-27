'use client';

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

export interface SelectPickerOption<V extends string = string> {
  value: V;
  label: string;
  hint?: string;
}

export interface SelectPickerProps<V extends string = string> {
  options: SelectPickerOption<V>[];
  value: V;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  portal?: boolean;
  onChange: (value: V) => void;
}

export function SelectPicker<V extends string = string>({
  options,
  value,
  disabled,
  ariaLabel,
  placeholder = '— Select —',
  portal = false,
  onChange,
}: SelectPickerProps<V>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !portal) return;

    let animationFrame = 0;
    function updatePosition() {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const wrap = wrapRef.current;
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        const visualViewport = window.visualViewport;
        const viewportLeft = visualViewport?.offsetLeft ?? 0;
        const viewportTop = visualViewport?.offsetTop ?? 0;
        const viewportWidth = visualViewport?.width ?? window.innerWidth;
        const viewportHeight = visualViewport?.height ?? window.innerHeight;
        const portalHost = wrap.closest('.page');
        const hostRect = portalHost?.getBoundingClientRect() ?? {
          top: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
          left: 0,
        };
        const availableWidth = Math.max(0, viewportWidth - 16);
        const minWidth = Math.min(Math.max(rect.width, 180), availableWidth);
        const viewportLeftPosition = Math.min(
          Math.max(viewportLeft + 8, rect.left),
          viewportLeft + viewportWidth - minWidth - 8,
        );
        const spaceAbove = Math.max(0, rect.top - viewportTop - 14);
        const spaceBelow = Math.max(0, viewportTop + viewportHeight - rect.bottom - 14);
        const openAbove = spaceAbove >= 96 || spaceAbove >= spaceBelow;
        setDropdownStyle({
          left: viewportLeftPosition - hostRect.left,
          top: openAbove ? 'auto' : rect.bottom - hostRect.top + 6,
          bottom: openAbove ? hostRect.bottom - rect.top + 6 : 'auto',
          minWidth,
          maxHeight: openAbove ? spaceAbove : spaceBelow,
        });
      });
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.visualViewport?.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('scroll', updatePosition);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.visualViewport?.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('scroll', updatePosition);
    };
  }, [open, portal]);

  const selected = options.find((o) => o.value === value);
  const label = selected ? selected.label : placeholder;
  const portalHost = typeof document !== 'undefined'
    ? wrapRef.current?.closest('.page') || document.querySelector('.chatPageRoot .page') || document.body
    : null;
  const dropdown = open && !disabled ? (
    <div
      ref={dropdownRef}
      className={`themedPickerDropdown${portal ? ' themedPickerDropdownPortal' : ''}`}
      role="listbox"
      aria-label={ariaLabel}
      style={portal ? dropdownStyle || undefined : undefined}
    >
      {options.length === 0 ? (
        <div className="themedPickerEmpty">No options</div>
      ) : (
        options.map((o) => {
          const isSelected = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="option"
              data-value={o.value}
              aria-selected={isSelected}
              className={`themedPickerOption ${isSelected ? 'themedPickerOptionActive' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span className="themedPickerOptionLabel">
                {o.label}
                {o.hint ? <span className="themedPickerOptionId"> {o.hint}</span> : null}
              </span>
              {isSelected ? <span className="themedPickerOptionCheck">✓</span> : null}
            </button>
          );
        })
      )}
    </div>
  ) : null;

  return (
    <div className="themedPickerWrap" ref={wrapRef}>
      <button
        type="button"
        className={`themedPickerTrigger ${open ? 'themedPickerOpen' : ''}`}
        data-value={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((p) => !p)}
      >
        <span className="themedPickerLabel">{label}</span>
        <span className="themedPickerCaret" aria-hidden="true">▾</span>
      </button>
      {portal ? (dropdown && portalHost && dropdownStyle ? createPortal(dropdown, portalHost) : null) : dropdown}
    </div>
  );
}
