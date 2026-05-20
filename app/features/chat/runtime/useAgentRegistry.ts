'use client';

import { useEffect, useState } from 'react';
import type { Agent } from '../../agents/agentTypes';
import { warmLocalAgentsOnce } from '../chatApi';
import { SCHEDULER_AGENT_ID } from '../chatHelpers';
import { STORAGE_AGENT_FILTER, STORAGE_REMEMBERED_CHAT_AGENTS } from './sessionPersistence';
import type { EnsureAgentModelsOptions } from './chatRuntimeTypes';

export type UseAgentRegistryParams = {
  acp: (body: Record<string, unknown>) => Promise<any>;
};

export function useAgentRegistry({ acp }: UseAgentRegistryParams) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [rememberedChatAgents, setRememberedChatAgentsState] = useState<Record<string, string>>({});

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
    try {
      const savedRememberedAgents = window.localStorage.getItem(STORAGE_REMEMBERED_CHAT_AGENTS);
      if (savedRememberedAgents) {
        const parsed = JSON.parse(savedRememberedAgents) as Record<string, unknown>;
        const next: Record<string, string> = {};
        for (const [chatId, agentId] of Object.entries(parsed)) {
          if (chatId && typeof agentId === 'string' && agentId) next[chatId] = agentId;
        }
        setRememberedChatAgentsState(next);
      }
    } catch { /* ignore */ }
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

  function persistRememberedChatAgents(next: Record<string, string>) {
    setRememberedChatAgentsState(next);
    try { window.localStorage.setItem(STORAGE_REMEMBERED_CHAT_AGENTS, JSON.stringify(next)); } catch { /* ignore */ }
  }

  function rememberChatAgent(chatId: string, agentId: string) {
    if (!chatId || !agents.some(a => a.id === agentId)) return;
    setRememberedChatAgentsState(prev => {
      const next = { ...prev, [chatId]: agentId };
      try { window.localStorage.setItem(STORAGE_REMEMBERED_CHAT_AGENTS, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  function clearRememberedChatAgent(chatId: string) {
    setRememberedChatAgentsState(prev => {
      if (!prev[chatId]) return prev;
      const next = { ...prev };
      delete next[chatId];
      try { window.localStorage.setItem(STORAGE_REMEMBERED_CHAT_AGENTS, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }

  async function reloadAgents() {
    setAgentsLoading(true);
    try {
      const [agentsData, prefsData] = await Promise.all([
        acp({ action: 'list-agents' }),
        acp({ action: 'get-model-prefs' }).catch(() => null),
      ]);
      if (agentsData.ok && Array.isArray(agentsData.agents)) {
        const loadedAgents = agentsData.agents as Agent[];
        setAgents(loadedAgents);
        warmLocalAgentsOnce(acp, loadedAgents);
      }
      if (prefsData?.ok && prefsData.prefs && typeof prefsData.prefs === 'object') {
        mergeModelPrefs(prefsData.prefs as Record<string, string>);
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
    rememberedChatAgents,
    setRememberedChatAgents: persistRememberedChatAgents,
    rememberChatAgent,
    clearRememberedChatAgent,
    reloadAgents,
    ensureAgentModels,
  };
}
