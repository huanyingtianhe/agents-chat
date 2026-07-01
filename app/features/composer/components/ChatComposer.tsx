'use client';

import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import type { Agent } from '../../agents/agentTypes';
import type { ChatAttachment } from '../attachmentTypes';
import type { SlashCommand } from '../slashCommandTypes';
import { ATTACHMENT_ACCEPT } from '../attachmentHelpers';
import { AttachmentList } from './AttachmentList';
import { SlashCommandPalette } from './SlashCommandPalette';

type ChatComposerProps = {
  composerRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  input: string;
  attachments: ChatAttachment[];
  attachmentError: string | null;
  isDraggingAttachment: boolean;
  mentionAgents: Agent[];
  mentionSelectedIndex: number;
  slashCommands: SlashCommand[];
  slashSelectedIndex: number;
  targetControls: ReactNode;
  isSending: boolean;
  sendDisabled: boolean;
  onMentionSelect: (agentId: string) => void;
  onSlashCommandSelect: (command: SlashCommand) => void;
  onFilesSelected: (files: FileList) => void;
  onRemoveAttachment: (id: string) => void;
  onPreviewAttachment: (dataUrl: string) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onInput: () => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onSend: () => void;
  onStop: () => void;
};

export function ChatComposer({
  composerRef,
  fileInputRef,
  input,
  attachments,
  attachmentError,
  isDraggingAttachment,
  mentionAgents,
  mentionSelectedIndex,
  slashCommands,
  slashSelectedIndex,
  targetControls,
  isSending,
  sendDisabled,
  onMentionSelect,
  onSlashCommandSelect,
  onFilesSelected,
  onRemoveAttachment,
  onPreviewAttachment,
  onPaste,
  onKeyDown,
  onInput,
  onDragOver,
  onDragLeave,
  onDrop,
  onSend,
  onStop,
}: ChatComposerProps) {
  return (
    <section className="chatInputDock">
      <div className="composerStack">
        {mentionAgents.length > 0 && (
          <div className="mentionDropdown">
            {mentionAgents.map((agent, idx) => (
              <button
                key={agent.id}
                className={`mentionItem ${mentionSelectedIndex === idx ? 'selected' : ''}`}
                onClick={() => onMentionSelect(agent.id)}
              >
                <span className="mentionId">@{agent.id}</span>
                <span className="mentionDesc">{agent.name || ''}</span>
              </button>
            ))}
          </div>
        )}
        {mentionAgents.length === 0 && slashCommands.length > 0 && (
          <SlashCommandPalette
            commands={slashCommands}
            selectedIndex={slashSelectedIndex}
            onSelect={onSlashCommandSelect}
          />
        )}
        <div className="inputArea">
          <div
            className={`composerShell ${isDraggingAttachment ? 'dragOver' : ''}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="srOnlyFileInput"
              onChange={(event) => {
                const files = event.currentTarget.files;
                if (files && files.length > 0) onFilesSelected(files);
                event.currentTarget.value = '';
              }}
            />
            <AttachmentList
              attachments={attachments}
              mode="composer"
              onRemove={onRemoveAttachment}
              onPreview={onPreviewAttachment}
            />
            {attachmentError ? <div className="attachmentError" role="alert">{attachmentError}</div> : null}
            <div className="composerTextRow">
              <textarea
                ref={composerRef}
                className="composerTextarea"
                defaultValue={input}
                onPaste={onPaste}
                onKeyDown={onKeyDown}
                placeholder="Message Agents Chat — type / for commands, @ to mention an agent"
                rows={1}
                spellCheck={false}
                onInput={onInput}
              />
            </div>
            <div className="composerToolbar">
              <div className="composerToolbarLeft">
                <button
                  type="button"
                  className="attachButton"
                  aria-label="Attach files or photos"
                  title="Attach files or photos"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <span className="attachButtonIcon" aria-hidden="true">
                    <svg viewBox="0 0 16 16" focusable="false">
                      <path d="M5.2 8.9l4.4-4.4a2.1 2.1 0 0 1 3 3l-5.3 5.3a3.4 3.4 0 0 1-4.8-4.8l5.6-5.6a.8.8 0 1 1 1.1 1.1L3.6 9.1a1.8 1.8 0 0 0 2.6 2.6l5.3-5.3a.5.5 0 0 0-.7-.7L6.3 10.1a.8.8 0 1 1-1.1-1.2z" />
                    </svg>
                  </span>
                </button>
                {targetControls}
              </div>
              <div className="composerActions composerToolbarActions">
                {isSending
                  ? <button className="sendButton stopButton" onClick={onStop} aria-label="Stop generation"><span className="stopButtonIcon" aria-hidden="true" /></button>
                  : <button className="sendButton" onClick={onSend} disabled={sendDisabled} aria-label="Send message">
                      <span className="sendButtonIcon">↑</span>
                    </button>
                }
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
