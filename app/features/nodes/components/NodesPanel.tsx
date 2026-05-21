'use client';

import { useNodePanelState } from '../hooks/useNodePanelState';

export interface NodesPanelProps {
  panelState: ReturnType<typeof useNodePanelState>;
}

export function NodesPanel({ panelState }: NodesPanelProps) {
  const {
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
  } = panelState;

  return (
    <>
      {/* ── Right sidebar: nodes ── */}
      {showNodesPanel && (
        <aside className={`agentsSidebar ${showNodesPanel ? 'mobilePanelVisible' : ''}`}>
          <div className="agentsSidebarHeader">
            <span>Nodes</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button className="sidebarToggle" onClick={() => loadNodes()} title="Refresh all">↻</button>
              <div style={{ position: 'relative' }}>
                <button className="sidebarToggle" onClick={() => { setShowSetupScript(true); }} title="Add node">+</button>
              </div>
              <button className="sidebarToggle" onClick={() => setShowNodesPanel(false)}>→</button>
            </div>
          </div>
          <div className="agentsSidebarSection">
            {nodesData.map((node) => (
              <button key={node.name} className="agentListItem" onClick={() => handleRefreshNode(node.name)} title={`Click to refresh — ${node.online ? 'Online' : 'Offline'}`}>
                <span className="agentListAvatar nodeAvatar" data-online={node.online ? '' : undefined}>{node.label.slice(0, 1).toUpperCase()}</span>
                <span className="agentListInfo">
                  {editingNodeName === node.name ? (
                    <input
                      className="nodeEditInput"
                      value={editingNodeLabel}
                      onChange={(e) => setEditingNodeLabel(e.target.value)}
                      onBlur={() => { if (editingNodeLabel.trim() && editingNodeLabel !== node.label) handleRenameNode(node.name, editingNodeLabel.trim()); setEditingNodeName(null); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } if (e.key === 'Escape') { setEditingNodeName(null); } }}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span className="agentListName" onDoubleClick={(e) => { if (node.canModify) { e.stopPropagation(); setEditingNodeName(node.name); setEditingNodeLabel(node.label); } }} title={node.canModify ? 'Double-click to rename' : undefined}>{node.label}</span>
                  )}
                  <span className="agentListId">{node.name}{!node.manual ? ' · auto' : ''}</span>
                </span>
                <span className={`agentListStatus ${node.online ? 'running' : ''}`}>{node.online ? '●' : '○'}</span>
                {node.canModify && (
                  <span className="nodeActionBtn" onClick={(e) => { e.stopPropagation(); openRelayAgent(node.name); }} title="Add agent on this node">＋</span>
                )}
                {node.canModify && (
                  <span className="nodeRemoveBtn" onClick={(e) => { e.stopPropagation(); handleRemoveNode(node.name); }} title="Remove node">✕</span>
                )}
              </button>
            ))}
            {nodesData.length === 0 && (
              <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
                {nodesLoading ? 'Checking nodes...' : 'No nodes configured'}
              </div>
            )}
          </div>

          {/* Add node form */}
          {showAddNode && (
            <div className="nodeAddForm">
              <div className="nodeAddFormTitle">Add Node</div>
              <input className="nodeAddInput" placeholder="Connection name (e.g. cpc-team-vm1)" value={newNodeForm.name} onChange={(e) => setNewNodeForm(f => ({ ...f, name: e.target.value }))} />
              <input className="nodeAddInput" placeholder="Display label (optional)" value={newNodeForm.label} onChange={(e) => setNewNodeForm(f => ({ ...f, label: e.target.value }))} />
              <div className="nodeAddActions">
                <button className="ghostButton nodeAddBtn" onClick={handleAddNode} disabled={addNodeLoading || !newNodeForm.name.trim()}>
                  {addNodeLoading ? '...' : 'Add'}
                </button>
                <button className="ghostButton nodeAddBtn" onClick={() => { setShowAddNode(false); setNewNodeForm({ name: '', label: '' }); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </aside>
      )}

      {/* ── Setup script modal ── */}
      {showSetupScript && (
        <div className="modalOverlay">
          <div className="modal setupScriptModal">
            <h2>🖥️ Node Setup Kit</h2>
            <p className="setupScriptDesc">
              Download the setup kit and run it on your devbox to connect it as a node.
              It includes <code>setup-node.ps1</code> and <code>relay-listener.js</code>.
            </p>
            <div className="setupScriptSteps">
              <div className="setupScriptStep">
                <span className="setupStepNum">1</span>
                <span>Download and extract the zip</span>
              </div>
              <div className="setupScriptStep">
                <span className="setupStepNum">2</span>
                <span>Open PowerShell in the extracted folder</span>
              </div>
              <div className="setupScriptStep">
                <span className="setupStepNum">3</span>
                <span>Run: <code>.\setup-node.ps1</code></span>
              </div>
              <div className="setupScriptStep">
                <span className="setupStepNum">4</span>
                <span>The node appears here automatically</span>
              </div>
            </div>
            <div className="setupScriptNote">
              <strong>Prerequisites:</strong> Node.js, GitHub Copilot CLI, Azure CLI (logged in)
            </div>
            <div className="setupScriptActions">
              <button className="ghostButton setupDownloadBtn" onClick={() => downloadSetupZip()}>
                📦 Download copilot-node-setup.zip
              </button>
              <button className="ghostButton" onClick={() => setShowSetupScript(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add relay agent modal ── */}
      {showAddRelayAgent && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal">
            <h2>➕ Add Agent on <code>{relayAgentNode}</code></h2>
            <label>
              <span>Agent ID</span>
              <input value={newRelayAgentForm.id} onChange={(e) => setNewRelayAgentForm(f => ({ ...f, id: e.target.value }))} placeholder="unique-agent-id" />
              <span className="fieldHint">Unique identifier, lowercase with hyphens</span>
            </label>
            <label>
              <span>Agent Name</span>
              <input value={newRelayAgentForm.name} onChange={(e) => setNewRelayAgentForm(f => ({ ...f, name: e.target.value }))} placeholder="My Remote Agent" />
              <span className="fieldHint">Display name for the agent</span>
            </label>
            <label>
              <span>Working Directory (on the remote node)</span>
              <input value={newRelayAgentForm.cwd} onChange={(e) => setNewRelayAgentForm(f => ({ ...f, cwd: e.target.value }))} placeholder="/home/user/project or C:\Repos\MyProject" />
              <span className="fieldHint">The cwd the copilot agent runs in on that node</span>
            </label>
            <div className="modalActions">
              <button onClick={() => void createRelayAgent()} disabled={addRelayAgentLoading || !newRelayAgentForm.id.trim()}>
                {addRelayAgentLoading ? 'Creating...' : 'Create Relay Agent'}
              </button>
              <button className="secondary" onClick={closeRelayAgent}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
