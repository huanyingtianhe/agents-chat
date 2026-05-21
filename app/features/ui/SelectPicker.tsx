'use client';

import { useEffect, useRef, useState } from 'react';

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
  onChange: (value: V) => void;
}

export function SelectPicker<V extends string = string>({
  options,
  value,
  disabled,
  ariaLabel,
  placeholder = '— Select —',
  onChange,
}: SelectPickerProps<V>) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocDown(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
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

  const selected = options.find((o) => o.value === value);
  const label = selected ? selected.label : placeholder;

  return (
    <div className="themedPickerWrap" ref={wrapRef}>
      <button
        type="button"
        className={`themedPickerTrigger ${open ? 'themedPickerOpen' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => setOpen((p) => !p)}
      >
        <span className="themedPickerLabel">{label}</span>
        <span className="themedPickerCaret" aria-hidden="true">▾</span>
      </button>
      {open && !disabled && (
        <div className="themedPickerDropdown" role="listbox" aria-label={ariaLabel}>
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
      )}
    </div>
  );
}
