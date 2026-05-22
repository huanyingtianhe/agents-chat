'use client';

import { createPortal } from 'react-dom';
import type { CSSProperties, MutableRefObject } from 'react';
import type { Agent } from '../../agents/agentTypes';
import type { ChatHistoryEntry } from '../chatTypes';
import { normalizeChatHistory } from '../chatHelpers';

export type ChatSidebarStatus = { label: string; kind: 'running' | 'done' | 'error' };

function getStatusDisplayText(label: string | undefined, fallback: string): string {
  const trimmed = label?.trim() || '';
  return /[A-Za-z0-9]/.test(trimmed) ? trimmed : fallback;
}

function getSidebarStatusDisplayLabel(label: string): string {
  return getStatusDisplayText(label, 'Running').match(/[A-Za-z0-9]+/)?.[0] || 'Running';
}

type ChatSidebarListProps = {
  chatHistory: ChatHistoryEntry[];
  currentChatId: string;
  activeSidebarChatId: string;
  chatName: string;
  chatAgentFilter: string | null;
  chatFilterAgents: Agent[];
  mounted: boolean;
  openChatMenuId: string | null;
  renamingChatId: string | null;
  renameValue: string;
  themeStyle: CSSProperties;
  chatMenuButtonRefs: MutableRefObject<Map<string, HTMLButtonElement>>;
  actionMenuWidth: number;
  actionMenuHeight: number;
  getChatSidebarStatus: (chatId: string) => ChatSidebarStatus | null;
  onCreateChat: () => void;
  onLoadChat: (chatId: string) => void;
  onOpenChatMenu: (chatId: string | null) => void;
  onRenameValueChange: (value: string) => void;
  onCancelRename: () => void;
  onStartRename: (chat: ChatHistoryEntry, isCurrent: boolean) => void;
  onRenameChat: (chatId: string, value: string) => void;
  onShareChat: (chatId: string) => void;
  onDeleteChat: (chatId: string) => void;
};

export function ChatSidebarList({
  chatHistory,
  currentChatId,
  activeSidebarChatId,
  chatName,
  chatAgentFilter,
  chatFilterAgents,
  mounted,
  openChatMenuId,
  renamingChatId,
  renameValue,
  themeStyle,
  chatMenuButtonRefs,
  actionMenuWidth,
  actionMenuHeight,
  getChatSidebarStatus,
  onCreateChat,
  onLoadChat,
  onOpenChatMenu,
  onRenameValueChange,
  onCancelRename,
  onStartRename,
  onRenameChat,
  onShareChat,
  onDeleteChat,
}: ChatSidebarListProps) {
  const allChats = (currentChatId && !chatHistory.some((chat) => chat.id === currentChatId))
    ? [{ id: currentChatId, name: chatName, ts: chatHistory[0]?.ts ? chatHistory[0].ts + 1 : Date.now() }, ...chatHistory]
    : chatHistory;
  const uniqueChats = normalizeChatHistory(allChats);
  const filteredChats = (chatAgentFilter
    ? uniqueChats.filter((chat) => chat.agentId === chatAgentFilter || (!chat.agentId && chat.id === currentChatId))
    : uniqueChats
  ).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const selectedAgentName = chatAgentFilter
    ? chatFilterAgents.find((agent) => agent.id === chatAgentFilter)?.name || chatAgentFilter
    : '';

  return (
    <>
      <div className="newChatRow">
        <button className="newChatButton" onClick={onCreateChat}>
          + New Chat{chatAgentFilter ? ` (${selectedAgentName})` : ''}
        </button>
      </div>
      {filteredChats.map((chat) => {
        const isCurrent = chat.id === currentChatId;
        const isActive = chat.id === activeSidebarChatId;
        const sidebarStatus = getChatSidebarStatus(chat.id);
        const isRenaming = renamingChatId === chat.id;
        return (
          <div key={chat.id} className={`chatHistoryRow ${isActive ? 'active' : ''}`}>
            {isRenaming ? (
              <div className="chatRenameWrap">
                <input
                  className="chatRenameInput"
                  autoFocus
                  value={renameValue}
                  onChange={(event) => onRenameValueChange(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') onRenameChat(chat.id, renameValue);
                    if (event.key === 'Escape') onCancelRename();
                  }}
                  onBlur={() => onRenameChat(chat.id, renameValue)}
                />
              </div>
            ) : (
              <button
                className={`chatHistoryItem ${isActive ? 'active' : ''}`}
                title={chat.name}
                onClick={() => (isCurrent ? undefined : onLoadChat(chat.id))}
              >
                <span className="chatHistoryIcon">{isActive ? '💬' : '📝'}</span>
                <span className="chatHistoryText">
                  <span className="chatHistoryName">{isCurrent ? chatName : chat.name}</span>
                  <span className="chatHistoryMetaRow">
                    <span className="chatHistoryMeta" suppressHydrationWarning>
                      {mounted ? new Date(chat.ts).toLocaleDateString() : ''}
                    </span>
                    {sidebarStatus ? (
                      <span
                        className={`chatStatusBadge ${sidebarStatus.kind}`}
                        title={getStatusDisplayText(sidebarStatus.label, 'Running')}
                      >
                        {getSidebarStatusDisplayLabel(sidebarStatus.label)}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            )}
            <div className="chatActionsWrap">
              <button
                type="button"
                ref={(node) => {
                  if (node) chatMenuButtonRefs.current.set(chat.id, node);
                  else chatMenuButtonRefs.current.delete(chat.id);
                }}
                className={`chatMoreBtn ${openChatMenuId === chat.id ? 'active' : ''}`}
                title="Chat actions"
                aria-haspopup="menu"
                aria-expanded={openChatMenuId === chat.id}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenChatMenu(openChatMenuId === chat.id ? null : chat.id);
                }}
              >
                ...
              </button>
              {openChatMenuId === chat.id
                ? (() => {
                    const rect = chatMenuButtonRefs.current.get(chat.id)?.getBoundingClientRect();
                    if (!rect) return null;
                    const left = Math.max(8, Math.min(rect.right - actionMenuWidth, window.innerWidth - actionMenuWidth - 8));
                    const top = Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - actionMenuHeight - 8));
                    return createPortal(
                      <div
                        className="chatActionsMenu"
                        role="menu"
                        style={{ ...themeStyle, position: 'fixed', top, left, right: 'auto', width: actionMenuWidth, zIndex: 9999 }}
                      >
                        <button
                          type="button"
                          className="chatActionItem"
                          role="menuitem"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenChatMenu(null);
                            onStartRename(chat, isCurrent);
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className="chatActionItem"
                          role="menuitem"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenChatMenu(null);
                            onShareChat(chat.id);
                          }}
                        >
                          Share
                        </button>
                        <button
                          type="button"
                          className="chatActionItem danger"
                          role="menuitem"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteChat(chat.id);
                          }}
                        >
                          Delete
                        </button>
                      </div>,
                      document.body,
                    );
                  })()
                : null}
            </div>
          </div>
        );
      })}
    </>
  );
}
