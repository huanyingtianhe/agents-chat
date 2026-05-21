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
  const [agentAccessList, setAgentAccessList] = useState<AccessEntry[]>([]);
  const [newAccessEmail, setNewAccessEmail] = useState('');

  function openAddAgent() {
    setShowAgentAddMenu(false);
    setShowAddAgent(true);
  }

  function closeAddAgent() {
    setShowAddAgent(false);
    setNewAgentForm({ id: '', name: '', command: '', args: '', cwd: DEFAULT_CWD, yolo: true, env: '' });
  }

  async function createAgent() {
    const { id, name, command, args, cwd, yolo, env } = newAgentForm;
    const trimmedId = id.trim();
    if (!trimmedId) return;
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
      if (data.ok) {
        await loadAgents();
        addMessage({ type: 'system', content: `✅ Agent "${name.trim() || trimmedId}" created` });
        setShowAddAgent(false);
        setNewAgentForm({ id: '', name: '', command: '', args: '', cwd: DEFAULT_CWD, yolo: true, env: '' });
      } else {
        addMessage({ type: 'system', content: `❌ Failed: ${data.error}` });
      }
    } catch {
      addMessage({ type: 'system', content: '❌ Failed to create agent' });
    } finally {
      setAddAgentLoading(false);
    }
  }

  function openAddRemoteAgent() {
    setShowAgentAddMenu(false);
    setNewRemoteAgentForm({ id: '', name: '', nodeName: '', cwd: DEFAULT_CWD });
    setShowAddRemoteAgent(true);
    void loadNodes();
  }

  async function createRemoteAgent() {
    const { id, name, nodeName, cwd } = newRemoteAgentForm;
    const trimmedId = id.trim();
    if (!trimmedId || !nodeName) return;
    const agentId = trimmedId;
    const displayName = name.trim() || nodeName;
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
      if (data.ok) {
        await loadAgents();
        addMessage({ type: 'system', content: `✅ Remote agent "${displayName}" created on node ${nodeName}` });
        setShowAddRemoteAgent(false);
        setNewRemoteAgentForm({ id: '', name: '', nodeName: '', cwd: DEFAULT_CWD });
      } else {
        addMessage({ type: 'system', content: `❌ Failed: ${data.error}` });
      }
    } catch {
      addMessage({ type: 'system', content: '❌ Failed to create remote agent' });
    } finally {
      setAddAgentLoading(false);
    }
  }

  async function openAgentSettings(agentId: string) {
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
      if (configData.ok) {
        setSettingsAgentConfig(configData.agent);
        const env = configData.agent.env || {};
        setSettingsEnvText(Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'));
      }
      if (accessData.ok) setAgentAccessList(accessData.access || []);
    } catch (err) {
      console.error('Failed to load agent config', err);
    } finally {
      setAgentSettingsLoading(false);
    }
  }

  async function addAccess() {
    if (!settingsAgentId || !newAccessEmail.trim()) return;
    await acp({ action: 'add-agent-access', agentId: settingsAgentId, email: newAccessEmail.trim() });
    setNewAccessEmail('');
    const data = await acp({ action: 'list-agent-access', agentId: settingsAgentId });
    if (data.ok) setAgentAccessList(data.access || []);
  }

  async function removeAccess(email: string) {
    if (!settingsAgentId) return;
    await acp({ action: 'remove-agent-access', agentId: settingsAgentId, email });
    const data = await acp({ action: 'list-agent-access', agentId: settingsAgentId });
    if (data.ok) setAgentAccessList(data.access || []);
  }

  async function saveAgentSettings() {
    if (!settingsAgentId || !settingsAgentConfig) return;
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
        action: 'update-agent-config', agentId: settingsAgentId,
        updates: {
          name: settingsAgentConfig.name,
          command: settingsAgentConfig.command,
          args: settingsAgentConfig.args,
          cwd: settingsAgentConfig.cwd,
          yolo: settingsAgentConfig.yolo,
          public: settingsAgentConfig.public,
          env: envObj,
        },
      });
      if (data.ok) {
        setShowAgentSettings(false);
        await loadAgents();
        addMessage({ type: 'system', content: data.restarted ? `⚙️ ${settingsAgentConfig.name} settings updated, restarting...` : `⚙️ ${settingsAgentConfig.name} settings saved` });
      }
    } catch (err) {
      console.error('Failed to save agent settings', err);
    } finally {
      setAgentSettingsLoading(false);
    }
  }

  async function deleteAgent(agentId: string, agentName: string) {
    if (!confirm(`Delete agent "${agentName}"? This cannot be undone.`)) return;
    setAgentSettingsLoading(true);
    try {
      const data = await acp({ action: 'delete-agent', agentId });
      if (data.ok) {
        setShowAgentSettings(false);
        await loadAgents();
        addMessage({ type: 'system', content: `🗑️ Agent "${agentName}" deleted` });
      }
    } catch (err) {
      console.error('Failed to delete agent', err);
    } finally {
      setAgentSettingsLoading(false);
    }
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
      if (openModelMenuAgentId) { setOpenModelMenuAgentId(null); return; }
      if (showAgentSettings) { setShowAgentSettings(false); return; }
      if (showAddAgent) { setShowAddAgent(false); setNewAgentForm({ id: '', name: '', command: '', args: '', cwd: DEFAULT_CWD, yolo: true, env: '' }); return; }
      if (showAddRemoteAgent) { setShowAddRemoteAgent(false); return; }
      if (showAgentAddMenu) { setShowAgentAddMenu(false); return; }
    }
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKey);
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
    formError: null as string | null,
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
    agentAccessList,
    newAccessEmail,
    setNewAccessEmail,
    openAgentSettings,
    closeAgentSettings: () => setShowAgentSettings(false),
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
