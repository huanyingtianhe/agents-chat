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
  const wrapRef = useRef<HTMLSpanElement | null>(null);

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
    <span className="schedulerAgentPickerWrap" ref={wrapRef}>
      <button
        type="button"
        className={`schedulerAgentPickerTrigger ${open ? 'schedulerAgentPickerOpen' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((p) => !p)}
      >
        <span className="schedulerAgentPickerLabel">{label}</span>
        <span className="schedulerAgentPickerCaret" aria-hidden="true">▾</span>
      </button>
      {open && !disabled && (
        <div className="agentModelDropdown schedulerAgentPickerDropdown" role="listbox" aria-label="Agent">
          {agents.length === 0 ? (
            <div className="agentModelOption" style={{ opacity: 0.7, cursor: 'default' }}>No agents available</div>
          ) : (
            agents.map((a) => {
              const isSelected = a.id === value;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`agentModelOption ${isSelected ? 'agentModelOptionActive' : ''}`}
                  onClick={() => { onChange(a.id); setOpen(false); }}
                  title={`@${a.id}`}
                >
                  <span className="agentModelOptionLabel">{a.name} <span style={{ opacity: 0.6 }}>({a.id})</span></span>
                  {isSelected ? <span className="agentModelOptionCheck">✓</span> : null}
                </button>
              );
            })
          )}
        </div>
      )}
    </span>
  );
}
