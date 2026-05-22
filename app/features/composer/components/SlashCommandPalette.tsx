'use client';

import { useEffect, useRef } from 'react';
import type { SlashCommand } from '../slashCommandTypes';

type SlashCommandPaletteProps = {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
};

export function SlashCommandPalette({ commands, selectedIndex, onSelect }: SlashCommandPaletteProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex, commands]);

  if (commands.length === 0) return null;
  return (
    <div className="mentionDropdown slashCommandDropdown" role="listbox" aria-label="Slash commands">
      {commands.map((cmd, idx) => (
        <button
          key={cmd.name}
          ref={(el) => { itemRefs.current[idx] = el; }}
          type="button"
          role="option"
          aria-selected={selectedIndex === idx}
          className={`mentionItem slashCommandItem ${selectedIndex === idx ? 'selected' : ''}`}
          onClick={() => onSelect(cmd)}
        >
          <span className="mentionId slashCommandName">
            /{cmd.name}{cmd.hint ? <span className="slashCommandHintInline"> {cmd.hint}</span> : null}
          </span>
          {cmd.description ? <span className="mentionDesc slashCommandDesc">{cmd.description}</span> : null}
        </button>
      ))}
    </div>
  );
}
