'use client';

import { useEffect, useState } from 'react';
import type { ChatMessage } from '../../chat/chatTypes';
import type { NodeData } from '../nodeTypes';

export type { NodeData };

const DEFAULT_CWD = 'Q:\\Repos\\workload-eventstream';

export type UseNodePanelStateParams = {
  acp: (body: Record<string, unknown>) => Promise<any>;
  loadAgents: () => Promise<void>;
  addMessage: (msg: Omit<ChatMessage, 'id' | 'ts'> & { id?: string; ts?: number }) => void;
};

async function nodesApi(body: Record<string, unknown>) {
  const res = await fetch('/api/nodes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export function useNodePanelState({
  acp,
  loadAgents,
  addMessage,
}: UseNodePanelStateParams) {
  const [showNodesPanel, setShowNodesPanel] = useState(false);
  const [nodesData, setNodesData] = useState<NodeData[]>([]);
  const [nodesLoading, setNodesLoading] = useState(false);

  // Add node form
  const [showAddNode, setShowAddNode] = useState(false);
  const [newNodeForm, setNewNodeForm] = useState({ name: '', label: '' });
  const [addNodeLoading, setAddNodeLoading] = useState(false);

  // Node editing
  const [editingNodeName, setEditingNodeName] = useState<string | null>(null);
  const [editingNodeLabel, setEditingNodeLabel] = useState('');
  const [showNodeAddMenu, setShowNodeAddMenu] = useState(false);

  // Setup script modal
  const [showSetupScript, setShowSetupScript] = useState(false);

  // Relay agent form (triggered from nodes panel)
  const [showAddRelayAgent, setShowAddRelayAgent] = useState(false);
  const [relayAgentNode, setRelayAgentNode] = useState('');
  const [newRelayAgentForm, setNewRelayAgentForm] = useState({ id: '', name: '', cwd: DEFAULT_CWD });
  const [addRelayAgentLoading, setAddRelayAgentLoading] = useState(false);

  async function loadNodes() {
    setNodesLoading(true);
    try {
      const data = await nodesApi({ action: 'list-nodes' });
      if (data.ok && Array.isArray(data.nodes)) {
        setNodesData(data.nodes);
      }
    } catch (err) {
      console.error('Failed to load nodes', err);
    } finally {
      setNodesLoading(false);
    }
  }

  async function handleAddNode() {
    if (!newNodeForm.name.trim()) return;
    setAddNodeLoading(true);
    try {
      const res = await nodesApi({
        action: 'add-node',
        name: newNodeForm.name.trim(),
        label: newNodeForm.label.trim() || newNodeForm.name.trim(),
      });
      if (res.ok) {
        setShowAddNode(false);
        setNewNodeForm({ name: '', label: '' });
        loadNodes();
      }
    } catch (err) {
      console.error('Failed to add node', err);
    } finally {
      setAddNodeLoading(false);
    }
  }

  async function handleRemoveNode(name: string) {
    try {
      const res = await nodesApi({ action: 'remove-node', name });
      if (res.ok) loadNodes();
    } catch (err) {
      console.error('Failed to remove node', err);
    }
  }

  async function handleRefreshNode(name: string) {
    try {
      const res = await nodesApi({ action: 'check-node', name });
      if (res.ok) {
        setNodesData(prev => prev.map(n => n.name === name ? { ...n, online: res.online, checkedAt: res.checkedAt } : n));
      }
    } catch (err) {
      console.error('Failed to check node', err);
    }
  }

  async function handleRenameNode(name: string, newLabel: string) {
    try {
      const res = await nodesApi({ action: 'update-node', name, label: newLabel });
      if (res.ok) {
        setNodesData(prev => prev.map(n => n.name === name ? { ...n, label: newLabel } : n));
      }
    } catch (err) {
      console.error('Failed to rename node', err);
    }
  }

  function downloadSetupZip(launcher: 'copilot' | 'agency' = 'copilot') {
    const a = document.createElement('a');
    const params = new URLSearchParams({ launcher });
    a.href = `/api/nodes/setup?${params.toString()}`;
    a.download = 'copilot-node-setup.zip';
    a.click();
  }

  function openRelayAgent(nodeName: string) {
    setRelayAgentNode(nodeName);
    setNewRelayAgentForm({ id: '', name: '', cwd: DEFAULT_CWD });
    setShowAddRelayAgent(true);
  }

  function closeRelayAgent() {
    setShowAddRelayAgent(false);
    setNewRelayAgentForm({ id: '', name: '', cwd: DEFAULT_CWD });
    setRelayAgentNode('');
  }

  async function createRelayAgent() {
    const { id, name, cwd } = newRelayAgentForm;
    const nodeName = relayAgentNode;
    const trimmedId = id.trim();
    if (!trimmedId || !nodeName) return;
    const displayName = name.trim() || trimmedId;
    setAddRelayAgentLoading(true);
    try {
      const data = await acp({
        action: 'create-agent',
        agent: {
          id: trimmedId,
          name: displayName,
          relay: true,
          relayConnectionName: nodeName,
          cwd: cwd.trim() || '/',
          yolo: true,
        },
      });
      if (data.ok) {
        await loadAgents();
        addMessage({ type: 'system', content: `✅ Relay agent "${displayName}" created on node ${nodeName}` });
        closeRelayAgent();
      } else {
        addMessage({ type: 'system', content: `❌ Failed: ${data.error}` });
      }
    } catch {
      addMessage({ type: 'system', content: '❌ Failed to create relay agent' });
    } finally {
      setAddRelayAgentLoading(false);
    }
  }

  useEffect(() => {
    const anyOpen = showSetupScript || showAddRelayAgent || showAddNode || showNodeAddMenu;
    if (!anyOpen) return;
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (showSetupScript) { setShowSetupScript(false); return; }
      if (showAddRelayAgent) { setShowAddRelayAgent(false); setNewRelayAgentForm({ id: '', name: '', cwd: DEFAULT_CWD }); setRelayAgentNode(''); return; }
      if (showAddNode) { setShowAddNode(false); return; }
      if (showNodeAddMenu) { setShowNodeAddMenu(false); return; }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [showSetupScript, showAddRelayAgent, showAddNode, showNodeAddMenu]);

  return {
    showNodesPanel,
    setShowNodesPanel,
    nodesData,
    nodesLoading,
    showAddNode,
    setShowAddNode,
    newNodeForm,
    setNewNodeForm,
    addNodeLoading,
    editingNodeName,
    setEditingNodeName,
    editingNodeLabel,
    setEditingNodeLabel,
    showNodeAddMenu,
    setShowNodeAddMenu,
    showSetupScript,
    setShowSetupScript,
    showAddRelayAgent,
    relayAgentNode,
    newRelayAgentForm,
    setNewRelayAgentForm,
    addRelayAgentLoading,
    loadNodes,
    handleAddNode,
    handleRemoveNode,
    handleRefreshNode,
    handleRenameNode,
    downloadSetupZip,
    openRelayAgent,
    closeRelayAgent,
    createRelayAgent,
  };
}
