'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../chat/chatTypes';
import type { Agent } from '../agentTypes';
import type { NodeData } from '../../nodes/nodeTypes';

export type { NodeData };

const DEFAULT_CWD = 'Q:\\Repos\\workload-eventstream';

export type AccessEntry = { email: string; grantedBy: string; createdAt: string };

export type AgentPanelState = {
  showAgentsPanel: boolean;
  setShowAgentsPanel: (value: boolean) => void;
  formValues: Record<string, string>;
  formError: string | null;
  isSubmitting: boolean;
};

export type AgentPanelActions = {
  openAddAgent: () => void;
  closeAddAgent: () => void;
  submitAddAgent: () => Promise<void>;
  openModelSettings: (agentId: string) => void;
  closeModelSettings: () => void;
};

export type UseAgentPanelStateParams = {
  acp: (body: Record<string, unknown>) => Promise<any>;
  loadAgents: () => Promise<void>;
  addMessage: (msg: Omit<ChatMessage, 'id' | 'ts'> & { id?: string; ts?: number }) => void;
  loadNodes: () => Promise<void>;
};

function mutationError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function requireSuccessfulMutation(data: any, fallback: string) {
  if (data?.ok === true) return;
  throw new Error(typeof data?.error === 'string' && data.error ? data.error : fallback);
}

export function useAgentPanelState({
  acp,
  loadAgents,
  addMessage,
  loadNodes,
}: UseAgentPanelStateParams) {
  const [showAgentsPanel, setShowAgentsPanel] = useState(false);

  // UI-only model menu state (open/close dropdown, refs)
  const [openModelMenuAgentId, setOpenModelMenuAgentId] = useState<string | null>(null);
  const modelMenuRefs = useRef<Map<string, HTMLSpanElement | null>>(new Map());

  // Add agent menu
  const [showAgentAddMenu, setShowAgentAddMenu] = useState(false);

  // Add local agent
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [newAgentForm, setNewAgentForm] = useState({
    id: '', name: '', command: '', args: '', cwd: DEFAULT_CWD, yolo: true, env: '',
  });
  const [addAgentLoading, setAddAgentLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Add remote agent
  const [showAddRemoteAgent, setShowAddRemoteAgent] = useState(false);
  const [newRemoteAgentForm, setNewRemoteAgentForm] = useState({
    id: '', name: '', nodeName: '', cwd: DEFAULT_CWD,
  });

  // Agent settings
  const [showAgentSettings, setShowAgentSettings] = useState(false);
  const [settingsAgentId, setSettingsAgentId] = useState<string | null>(null);
  const [settingsAgentConfig, setSettingsAgentConfig] = useState<Agent | null>(null);
  const [settingsEnvText, setSettingsEnvText] = useState('');
  const [agentSettingsLoading, setAgentSettingsLoading] = useState(false);
  const [agentAccessLoading, setAgentAccessLoading] = useState(false);
  const [agentAccessList, setAgentAccessList] = useState<AccessEntry[]>([]);
  const [newAccessEmail, setNewAccessEmail] = useState('');
  const settingsRequestGeneration = useRef(0);

  function openAddAgent() {
    setShowAgentAddMenu(false);
    setFormError(null);
    setShowAddAgent(true);
  }

  function closeAddAgent() {
    setFormError(null);
    setShowAddAgent(false);
    setNewAgentForm({ id: '', name: '', command: '', args: '', cwd: DEFAULT_CWD, yolo: true, env: '' });
  }

  async function createAgent() {
    if (addAgentLoading) return;
    const { id, name, command, args, cwd, yolo, env } = newAgentForm;
    const trimmedId = id.trim();
    if (!trimmedId) return;
    setFormError(null);
    setAddAgentLoading(true);
    try {
      const envObj: Record<string, string> = {};
      for (const line of env.split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim();
        if (key) envObj[key] = value;
      }

      const data = await acp({
        action: 'create-agent',
        agent: {
          id: trimmedId,
          name: name.trim() || trimmedId,
          command: command.trim() || 'copilot.exe',
          args: args.trim() ? args.trim().split(/\s+/) : ['--acp'],
          cwd: cwd.trim(),
          yolo,
          env: envObj,
        },
      });
      requireSuccessfulMutation(data, 'Failed to create agent');
      await loadAgents();
      addMessage({ type: 'system', content: `✅ Agent "${name.trim() || trimmedId}" created` });
      setShowAddAgent(false);
      setNewAgentForm({ id: '', name: '', command: '', args: '', cwd: DEFAULT_CWD, yolo: true, env: '' });
    } catch (error) {
      setFormError(mutationError(error, 'Failed to create agent'));
    } finally {
      setAddAgentLoading(false);
    }
  }

  function openAddRemoteAgent() {
    setShowAgentAddMenu(false);
    setFormError(null);
    setNewRemoteAgentForm({ id: '', name: '', nodeName: '', cwd: DEFAULT_CWD });
    setShowAddRemoteAgent(true);
    void loadNodes();
  }

  function closeAddRemoteAgent() {
    setFormError(null);
    setShowAddRemoteAgent(false);
  }

  async function createRemoteAgent() {
    if (addAgentLoading) return;
    const { id, name, nodeName, cwd } = newRemoteAgentForm;
    const trimmedId = id.trim();
    if (!trimmedId || !nodeName) return;
    const agentId = trimmedId;
    const displayName = name.trim() || nodeName;
    setFormError(null);
    setAddAgentLoading(true);
    try {
      const data = await acp({
        action: 'create-agent',
        agent: {
          id: agentId,
          name: displayName,
          relay: true,
          relayConnectionName: nodeName,
          cwd: cwd.trim() || '/',
          yolo: true,
        },
      });
      requireSuccessfulMutation(data, 'Failed to create remote agent');
      await loadAgents();
      addMessage({ type: 'system', content: `✅ Remote agent "${displayName}" created on node ${nodeName}` });
      setShowAddRemoteAgent(false);
      setNewRemoteAgentForm({ id: '', name: '', nodeName: '', cwd: DEFAULT_CWD });
    } catch (error) {
      setFormError(mutationError(error, 'Failed to create remote agent'));
    } finally {
      setAddAgentLoading(false);
    }
  }

  async function openAgentSettings(agentId: string) {
    const requestGeneration = ++settingsRequestGeneration.current;
    setFormError(null);
    setSettingsAgentId(agentId);
    setSettingsAgentConfig(null);
    setSettingsEnvText('');
    setShowAgentSettings(true);
    setAgentSettingsLoading(true);
    setAgentAccessList([]);
    setNewAccessEmail('');
    try {
      const [configData, accessData] = await Promise.all([
        acp({ action: 'get-agent-config', agentId }),
        acp({ action: 'list-agent-access', agentId }),
      ]);
      if (requestGeneration !== settingsRequestGeneration.current) return;
      requireSuccessfulMutation(configData, 'Failed to load agent settings');
      requireSuccessfulMutation(accessData, 'Failed to load agent settings');
      setSettingsAgentConfig(configData.agent);
      const env = configData.agent.env || {};
      setSettingsEnvText(Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'));
      setAgentAccessList(accessData.access || []);
    } catch (error) {
      if (requestGeneration !== settingsRequestGeneration.current) return;
      setFormError(mutationError(error, 'Failed to load agent settings'));
    } finally {
      if (requestGeneration === settingsRequestGeneration.current) {
        setAgentSettingsLoading(false);
      }
    }
  }

  async function addAccess() {
    if (agentSettingsLoading || agentAccessLoading || !settingsAgentId || !newAccessEmail.trim()) return;
    setFormError(null);
    setAgentAccessLoading(true);
    try {
      const updateData = await acp({ action: 'add-agent-access', agentId: settingsAgentId, email: newAccessEmail.trim() });
      requireSuccessfulMutation(updateData, 'Failed to update agent access');
      const accessData = await acp({ action: 'list-agent-access', agentId: settingsAgentId });
      requireSuccessfulMutation(accessData, 'Failed to update agent access');
      setNewAccessEmail('');
      setAgentAccessList(accessData.access || []);
    } catch (error) {
      setFormError(mutationError(error, 'Failed to update agent access'));
    } finally {
      setAgentAccessLoading(false);
    }
  }

  async function removeAccess(email: string) {
    if (agentSettingsLoading || agentAccessLoading || !settingsAgentId) return;
    setFormError(null);
    setAgentAccessLoading(true);
    try {
      const updateData = await acp({ action: 'remove-agent-access', agentId: settingsAgentId, email });
      requireSuccessfulMutation(updateData, 'Failed to update agent access');
      const accessData = await acp({ action: 'list-agent-access', agentId: settingsAgentId });
      requireSuccessfulMutation(accessData, 'Failed to update agent access');
      setAgentAccessList(accessData.access || []);
    } catch (error) {
      setFormError(mutationError(error, 'Failed to update agent access'));
    } finally {
      setAgentAccessLoading(false);
    }
  }

  async function saveAgentSettings() {
    if (
      agentSettingsLoading
      || agentAccessLoading
      || !settingsAgentId
      || !settingsAgentConfig
      || settingsAgentConfig.id !== settingsAgentId
    ) return;
    const agentId = settingsAgentId;
    const agentConfig = settingsAgentConfig;
    setFormError(null);
    setAgentSettingsLoading(true);
    try {
      // Parse env text to object on save
      const envObj: Record<string, string> = {};
      for (const line of settingsEnvText.split('\n')) {
        const eqIdx = line.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = line.slice(0, eqIdx).trim();
        const value = line.slice(eqIdx + 1).trim();
        if (key) envObj[key] = value;
      }

      const data = await acp({
        action: 'update-agent-config', agentId,
        updates: {
          name: agentConfig.name,
          command: agentConfig.command,
          args: agentConfig.args,
          cwd: agentConfig.cwd,
          yolo: agentConfig.yolo,
          public: agentConfig.public,
          env: envObj,
        },
      });
      requireSuccessfulMutation(data, 'Failed to update agent');
      setShowAgentSettings(false);
      await loadAgents();
      addMessage({ type: 'system', content: data.restarted ? `⚙️ ${agentConfig.name} settings updated, restarting...` : `⚙️ ${agentConfig.name} settings saved` });
    } catch (error) {
      setFormError(mutationError(error, 'Failed to update agent'));
    } finally {
      setAgentSettingsLoading(false);
    }
  }

  async function deleteAgent(agentId: string, agentName: string) {
    if (agentSettingsLoading || agentAccessLoading) return;
    if (!confirm(`Delete agent "${agentName}"? This cannot be undone.`)) return;
    setFormError(null);
    setAgentSettingsLoading(true);
    try {
      const data = await acp({ action: 'delete-agent', agentId });
      requireSuccessfulMutation(data, 'Failed to delete agent');
      setShowAgentSettings(false);
      await loadAgents();
      addMessage({ type: 'system', content: `🗑️ Agent "${agentName}" deleted` });
    } catch (error) {
      setFormError(mutationError(error, 'Failed to delete agent'));
    } finally {
      setAgentSettingsLoading(false);
    }
  }

  function closeAgentSettings() {
    settingsRequestGeneration.current += 1;
    setFormError(null);
    setShowAgentSettings(false);
    setSettingsAgentId(null);
    setSettingsAgentConfig(null);
    setSettingsEnvText('');
    setAgentAccessList([]);
    setNewAccessEmail('');
    setAgentSettingsLoading(false);
    setAgentAccessLoading(false);
  }

  function openModelSettings(agentId: string) { setOpenModelMenuAgentId(agentId); }
  function closeModelSettings() { setOpenModelMenuAgentId(null); }

  useEffect(() => {
    const anyOpen = openModelMenuAgentId || showAgentSettings || showAddAgent || showAddRemoteAgent || showAgentAddMenu;
    if (!anyOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (!openModelMenuAgentId) return;
      const wrap = modelMenuRefs.current.get(openModelMenuAgentId);
      if (wrap && !wrap.contains(event.target as Node)) {
        setOpenModelMenuAgentId(null);
      }
    }
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (openModelMenuAgentId) { event.stopImmediatePropagation(); setOpenModelMenuAgentId(null); return; }
      if (showAgentSettings) { event.stopImmediatePropagation(); closeAgentSettings(); return; }
      if (showAddAgent) { event.stopImmediatePropagation(); closeAddAgent(); return; }
      if (showAddRemoteAgent) { event.stopImmediatePropagation(); closeAddRemoteAgent(); return; }
      if (showAgentAddMenu) { event.stopImmediatePropagation(); setShowAgentAddMenu(false); return; }
    }
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKey, { capture: true });
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKey, { capture: true });
    };
  }, [openModelMenuAgentId, showAgentSettings, showAddAgent, showAddRemoteAgent, showAgentAddMenu]);

  // Minimal AgentPanelState/Actions compat
  const formValues: Record<string, string> = {
    agentId: newAgentForm.id,
    agentName: newAgentForm.name,
    command: newAgentForm.command,
    args: newAgentForm.args,
    cwd: newAgentForm.cwd,
  };

  async function submitAddAgent() {
    return createAgent();
  }

  return {
    // Panel visibility
    showAgentsPanel,
    setShowAgentsPanel,

    // Spec-compat fields
    formValues,
    formError,
    isSubmitting: addAgentLoading,

    // Add agent menu
    showAgentAddMenu,
    setShowAgentAddMenu,

    // Add local agent
    showAddAgent,
    newAgentForm,
    setNewAgentForm,
    addAgentLoading,
    openAddAgent,
    closeAddAgent,
    createAgent,
    submitAddAgent,

    // Add remote agent
    showAddRemoteAgent,
    setShowAddRemoteAgent,
    newRemoteAgentForm,
    setNewRemoteAgentForm,
    openAddRemoteAgent,
    closeAddRemoteAgent,
    createRemoteAgent,

    // Agent settings
    showAgentSettings,
    setShowAgentSettings,
    settingsAgentId,
    settingsAgentConfig,
    setSettingsAgentConfig,
    settingsEnvText,
    setSettingsEnvText,
    agentSettingsLoading,
    agentAccessLoading,
    agentAccessList,
    newAccessEmail,
    setNewAccessEmail,
    openAgentSettings,
    closeAgentSettings,
    saveAgentSettings,
    deleteAgent,
    addAccess,
    removeAccess,

    // UI-only model menu state
    openModelMenuAgentId,
    setOpenModelMenuAgentId,
    modelMenuRefs,

    // Model settings actions
    openModelSettings,
    closeModelSettings,
  };
}
