'use client';

import { useEffect, useState } from 'react';
import type { Agent } from '../../agents/agentTypes';
import { warmLocalAgentsOnce } from '../chatApi';
import { SCHEDULER_AGENT_ID } from '../chatHelpers';
import { STORAGE_AGENT_FILTER, STORAGE_REMEMBERED_CHAT_AGENTS } from './sessionPersistence';
import type { EnsureAgentModelsOptions } from './chatRuntimeTypes';

export type LastUsedAgentScope = 'user' | 'chat';
export const LAST_USED_AGENT_SCOPE_KEY = 'last_used_agent_scope';

export type UseAgentRegistryParams = {
  acp: (body: Record<string, unknown>) => Promise<any>;
};

export function useAgentRegistry({ acp }: UseAgentRegistryParams) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  // Per-user "last @-mentioned agent" — persisted server-side so it travels
  // across browsers/devices. Used when lastUsedAgentScope === 'user'.
  const [lastUsedAgent, setLastUsedAgentState] = useState<string | null>(null);
  // Per-chat "last @-mentioned agent" map, also server-side. Used when
  // lastUsedAgentScope === 'chat'. No fallback to the per-user value —
  // when a chat has no entry the composer falls back to chat primary agent.
  const [chatLastUsedAgents, setChatLastUsedAgentsState] = useState<Record<string, string>>({});
  // Which scope the composer reads/writes for the "last used agent" hint.
  const [lastUsedAgentScope, setLastUsedAgentScopeState] = useState<LastUsedAgentScope>('chat');

  // Agent filter — persisted in localStorage
  const [selectedAgentFilter, setSelectedAgentFilterState] = useState<string | null>(null);

  // Model selection state
  const [selectedAgentModels, setSelectedAgentModels] = useState<Record<string, string>>({});
  const [ensuringAgentModels, setEnsuringAgentModels] = useState<Record<string, boolean>>({});

  // Load persisted registry state from localStorage on mount
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_AGENT_FILTER);
      if (saved) setSelectedAgentFilterState(saved);
    } catch { /* ignore */ }
    // Clean up the legacy per-chat localStorage key — superseded by the
    // server-side tables loaded in reloadAgents.
    try { window.localStorage.removeItem(STORAGE_REMEMBERED_CHAT_AGENTS); } catch { /* ignore */ }
  }, []);

  function setSelectedAgentFilter(agentId: string | null) {
    setSelectedAgentFilterState(agentId);
    try { window.localStorage.setItem(STORAGE_AGENT_FILTER, agentId || ''); } catch { /* ignore */ }
  }

  function mergeModelPrefs(prefs: Record<string, string>) {
    setSelectedAgentModels((prev) => ({ ...prev, ...prefs }));
  }

  function setSelectedModelForAgent(agentId: string, modelId: string) {
    setSelectedAgentModels((prev) => ({ ...prev, [agentId]: modelId }));
    void acp({ action: 'set-model-pref', agentId, modelId }).catch(() => { /* ignore */ });
  }

  function rememberLastUsedAgent(agentId: string, chatId?: string) {
    if (!agentId) return;
    if (lastUsedAgentScope === 'chat' && chatId) {
      setChatLastUsedAgentsState((prev) => ({ ...prev, [chatId]: agentId }));
      void acp({ action: 'set-last-used-agent', agentId, chatId }).catch(() => { /* ignore */ });
    } else {
      setLastUsedAgentState(agentId);
      void acp({ action: 'set-last-used-agent', agentId }).catch(() => { /* ignore */ });
    }
  }

  function clearLastUsedAgent(chatId?: string) {
    if (lastUsedAgentScope === 'chat' && chatId) {
      setChatLastUsedAgentsState((prev) => {
        if (!prev[chatId]) return prev;
        const next = { ...prev };
        delete next[chatId];
        return next;
      });
      void acp({ action: 'set-last-used-agent', agentId: '', chatId }).catch(() => { /* ignore */ });
    } else {
      setLastUsedAgentState(null);
      void acp({ action: 'set-last-used-agent', agentId: '' }).catch(() => { /* ignore */ });
    }
  }

  function setLastUsedAgentScope(scope: LastUsedAgentScope) {
    setLastUsedAgentScopeState(scope);
    void acp({ action: 'set-user-setting', key: LAST_USED_AGENT_SCOPE_KEY, value: scope }).catch(() => { /* ignore */ });
  }

  async function reloadAgents() {
    setAgentsLoading(true);
    try {
      const [agentsData, prefsData, lastUsedData, chatLastUsedData, settingsData] = await Promise.all([
        acp({ action: 'list-agents' }),
        acp({ action: 'get-model-prefs' }).catch(() => null),
        acp({ action: 'get-last-used-agent' }).catch(() => null),
        acp({ action: 'get-chat-last-used-agents' }).catch(() => null),
        acp({ action: 'get-user-settings' }).catch(() => null),
      ]);
      if (agentsData.ok && Array.isArray(agentsData.agents)) {
        const loadedAgents = agentsData.agents as Agent[];
        setAgents(loadedAgents);
        warmLocalAgentsOnce(acp, loadedAgents);
      }
      if (prefsData?.ok && prefsData.prefs && typeof prefsData.prefs === 'object') {
        mergeModelPrefs(prefsData.prefs as Record<string, string>);
      }
      if (lastUsedData?.ok && typeof lastUsedData.agentId === 'string' && lastUsedData.agentId) {
        setLastUsedAgentState(lastUsedData.agentId);
      }
      if (chatLastUsedData?.ok && chatLastUsedData.map && typeof chatLastUsedData.map === 'object') {
        setChatLastUsedAgentsState(chatLastUsedData.map as Record<string, string>);
      }
      if (settingsData?.ok && settingsData.settings && typeof settingsData.settings === 'object') {
        const scope = (settingsData.settings as Record<string, string>)[LAST_USED_AGENT_SCOPE_KEY];
        if (scope === 'user' || scope === 'chat') setLastUsedAgentScopeState(scope);
      }
    } catch (err) {
      console.error('Failed to load agents', err);
    } finally {
      setAgentsLoading(false);
    }
  }

  useEffect(() => {
    void reloadAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function ensureAgentModels(agentId: string, opts: EnsureAgentModelsOptions) {
    const { currentChatId, currentAgentSessionsRef, setChatHistory } = opts;
    if (!currentChatId || agentId === SCHEDULER_AGENT_ID) return;
    if (ensuringAgentModels[agentId]) return;
    const currentModels = agents.find((a) => a.id === agentId)?.models;
    if (currentModels && currentModels.length > 0) return;
    setEnsuringAgentModels((prev) => ({ ...prev, [agentId]: true }));
    try {
      const data = await acp({ action: 'ensure-agent-models', agentId, chatId: currentChatId });
      if (data.ok) {
        const models = Array.isArray(data.models) ? data.models : [];
        setAgents((current) => current.map((agent) => agent.id === agentId ? { ...agent, models } : agent));
        const storedPref = selectedAgentModels[agentId];
        if (storedPref && models.length > 0 && !models.some((m: { modelId: string }) => m.modelId === storedPref)) {
          setSelectedAgentModels((prev) => { const next = { ...prev }; delete next[agentId]; return next; });
        }
        if (data.sessionId && currentAgentSessionsRef && setChatHistory) {
          currentAgentSessionsRef.current = { ...currentAgentSessionsRef.current, [agentId]: String(data.sessionId) };
          const chatId = currentChatId;
          setChatHistory((current) => current.map((chat) => chat.id === chatId
            ? { ...chat, agentSessions: { ...(chat.agentSessions || {}), [agentId]: String(data.sessionId) } }
            : chat));
        }
      }
    } catch (err) {
      console.error('Failed to ensure agent models', err);
    } finally {
      setEnsuringAgentModels((prev) => ({ ...prev, [agentId]: false }));
    }
  }

  return {
    agents,
    setAgents,
    agentsLoading,
    setAgentsLoading,
    selectedAgentFilter,
    setSelectedAgentFilter,
    selectedAgentModels,
    setSelectedAgentModels,
    ensuringAgentModels,
    setEnsuringAgentModels,
    mergeModelPrefs,
    setSelectedModelForAgent,
    lastUsedAgent,
    chatLastUsedAgents,
    lastUsedAgentScope,
    setLastUsedAgentScope,
    rememberLastUsedAgent,
    clearLastUsedAgent,
    reloadAgents,
    ensureAgentModels,
  };
}
