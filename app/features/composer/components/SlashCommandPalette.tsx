'use client';

import type { SlashCommand } from '../slashCommandTypes';

type SlashCommandPaletteProps = {
  commands: SlashCommand[];
  selectedIndex: number;
  onSelect: (command: SlashCommand) => void;
};

export function SlashCommandPalette({ commands, selectedIndex, onSelect }: SlashCommandPaletteProps) {
  if (commands.length === 0) return null;
  return (
    <div className="mentionDropdown slashCommandDropdown" role="listbox" aria-label="Slash commands">
      {commands.map((cmd, idx) => (
        <button
          key={cmd.name}
          type="button"
          role="option"
          aria-selected={selectedIndex === idx}
          className={`mentionItem slashCommandItem ${selectedIndex === idx ? 'selected' : ''}`}
          onClick={() => onSelect(cmd)}
        >
          <span className="mentionId slashCommandName">/{cmd.name}</span>
          {cmd.description ? <span className="mentionDesc slashCommandDesc">{cmd.description}</span> : null}
          {cmd.hint ? <span className="mentionDesc slashCommandHint">{cmd.hint}</span> : null}
        </button>
      ))}
    </div>
  );
}
