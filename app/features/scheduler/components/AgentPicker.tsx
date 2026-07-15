'use client';

import { useEffect, useRef, useState } from 'react';

export interface AgentPickerProps {
  agents: Array<{ id: string; name: string }>;
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
}

export function AgentPicker({ agents, value, disabled, onChange }: AgentPickerProps) {
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

  const selected = agents.find((a) => a.id === value);
  const label = selected ? `${selected.name} (${selected.id})` : '— Select an agent —';

  return (
    <div className="themedPickerWrap" ref={wrapRef}>
      <button
        type="button"
        className={`themedPickerTrigger ${open ? 'themedPickerOpen' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-value={value}
        disabled={disabled}
        onClick={() => setOpen((p) => !p)}
      >
        <span className="themedPickerLabel">{label}</span>
        <span className="themedPickerCaret" aria-hidden="true">▾</span>
      </button>
      {open && !disabled && (
        <div className="themedPickerDropdown" role="listbox" aria-label="Agent">
          {agents.length === 0 ? (
            <div className="themedPickerEmpty">No agents available</div>
          ) : (
            agents.map((a) => {
              const isSelected = a.id === value;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`themedPickerOption ${isSelected ? 'themedPickerOptionActive' : ''}`}
                  data-value={a.id}
                  onClick={() => { onChange(a.id); setOpen(false); }}
                  title={`@${a.id}`}
                >
                  <span className="themedPickerOptionLabel">
                    {a.name}
                    <span className="themedPickerOptionId"> ({a.id})</span>
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
