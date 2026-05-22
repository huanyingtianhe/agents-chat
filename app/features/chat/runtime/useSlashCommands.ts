'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlashCommand } from '../../composer/slashCommandTypes';

export type UseSlashCommandsParams = {
  acp: (body: Record<string, unknown>) => Promise<any>;
  agentId: string | null;
  chatId: string | null;
};

/**
 * Tracks slash commands advertised by an ACP agent for the current chat session.
 * Commands originate from `session/update` notifications with
 * `sessionUpdate: 'available_commands_update'` and are cached server-side per session.
 *
 * The hook refetches whenever the targeted agent or chat changes. Slash commands
 * can also appear later (e.g. after the agent finishes booting its session); callers
 * may invoke `refresh()` on demand (e.g. when the user first types `/`).
 */
export function useSlashCommands({ acp, agentId, chatId }: UseSlashCommandsParams) {
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const reqIdRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!agentId || !chatId) {
      setCommands([]);
      return;
    }
    const reqId = ++reqIdRef.current;
    try {
      const result = await acp({ action: 'get-slash-commands', agentId, chatId });
      if (reqId !== reqIdRef.current) return; // stale
      if (result?.ok && Array.isArray(result.commands)) {
        setCommands(result.commands as SlashCommand[]);
      } else {
        setCommands([]);
      }
    } catch {
      if (reqId === reqIdRef.current) setCommands([]);
    }
  }, [acp, agentId, chatId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { commands, refresh };
}
