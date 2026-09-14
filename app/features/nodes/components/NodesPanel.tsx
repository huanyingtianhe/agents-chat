'use client';

import { useState } from 'react';
import { useNodePanelState } from '../hooks/useNodePanelState';

export interface NodesPanelProps {
  panelState: ReturnType<typeof useNodePanelState>;
  onClose?: () => void;
  mobileModal?: boolean;
  mobileRestricted?: boolean;
}

type Launcher = 'copilot' | 'agency';

export function NodesPanel({ panelState, onClose, mobileModal = false, mobileRestricted = false }: NodesPanelProps) {
  const {
    showNodesPanel,
    setShowNodesPanel,
    nodesData,
    nodesLoading,
    nodesError,
    retryNodes,
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

  // Per-download choice; defaults to the lighter-weight direct copilot --acp path.
  const [setupLauncher, setSetupLauncher] = useState<Launcher>('copilot');

  return (
    <>
      {/* ── Right sidebar: nodes ── */}
      {showNodesPanel && (
        <aside className={`agentsSidebar ${showNodesPanel ? 'mobilePanelVisible' : ''}`} data-mobile-overlay-surface="nodes" tabIndex={-1} role={mobileModal ? 'dialog' : undefined} aria-modal={mobileModal || undefined} aria-label={mobileModal ? 'Nodes' : undefined}>
          <div className="agentsSidebarHeader">
            <span>Nodes</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button className="sidebarToggle" onClick={() => void loadNodes()} title="Refresh all" aria-label="Refresh all nodes">↻</button>
              {!mobileRestricted && (
                <div style={{ position: 'relative' }}>
                  <button className="sidebarToggle" onClick={() => { setShowSetupScript(true); }} title="Add node">+</button>
                </div>
              )}
              <button className="sidebarToggle" onClick={onClose ?? (() => setShowNodesPanel(false))} aria-label="Close nodes" data-mobile-overlay-initial-focus>→</button>
            </div>
          </div>
          {nodesError ? (
            <div className="panelError" role="alert">
              <span>{nodesError}</span>
              <button type="button" onClick={() => void retryNodes()}>Retry</button>
            </div>
          ) : null}
          <div className="agentsSidebarSection">
            {nodesData.map((node) => (
              <button
                key={node.name}
                className="agentListItem"
                onClick={() => void handleRefreshNode(node.name)}
                title={`Click to refresh — ${node.online ? 'Online' : 'Offline'}`}
                aria-label={`Refresh ${node.label}`}
              >
                <span className="agentListAvatar nodeAvatar" data-online={node.online ? '' : undefined}>{node.label.slice(0, 1).toUpperCase()}</span>
                <span className="agentListInfo">
                  {!mobileRestricted && editingNodeName === node.name ? (
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
                    <span
                      className="agentListName nodeListName"
                      onDoubleClick={(e) => {
                        if (!mobileRestricted && node.canModify) {
                          e.stopPropagation();
                          setEditingNodeName(node.name);
                          setEditingNodeLabel(node.label);
                        }
                      }}
                      title={!mobileRestricted && node.canModify ? `${node.label} — double-click to rename` : node.label}
                    >
                      {node.label}
                    </span>
                  )}
                  <span className="agentListId nodeListId" title={node.name}>{node.name}{!node.manual ? ' · auto' : ''}</span>
                  <span className="nodeStatusText">{node.online ? 'Online' : 'Offline'}</span>
                  {mobileRestricted ? <span className="nodePlatform">{node.platform || 'Platform unavailable'}</span> : null}
                  {mobileRestricted && node.connectionError ? <span className="nodeConnectionError">{node.connectionError}</span> : null}
                </span>
                {!mobileRestricted && node.canModify && (
                  <span className="nodeActionBtn" onClick={(e) => { e.stopPropagation(); openRelayAgent(node.name); }} title="Add agent on this node">＋</span>
                )}
                {!mobileRestricted && node.canModify && (
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
          {mobileRestricted ? <p className="mobileDesktopHint panelDesktopHint">Use the desktop interface to configure nodes.</p> : null}

          {/* Add node form */}
          {!mobileRestricted && showAddNode && (
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
      {!mobileRestricted && showSetupScript && (
        <div className="modalOverlay">
          <div className="modal setupScriptModal" role="dialog" aria-modal="true" aria-label="Node Setup Kit">
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
            <fieldset className="setupScriptLauncher">
              <legend>Start command for Copilot ACP</legend>
              <label className="setupScriptLauncherOption">
                <input
                  type="radio"
                  name="setup-launcher"
                  value="copilot"
                  checked={setupLauncher === 'copilot'}
                  onChange={() => setSetupLauncher('copilot')}
                />
                <span>
                  <code>copilot --acp</code>
                  <span className="setupScriptLauncherDesc">Runs the GitHub Copilot CLI directly. Installed via winget (<code>GitHub.Copilot</code>) if missing.</span>
                </span>
              </label>
              <label className="setupScriptLauncherOption">
                <input
                  type="radio"
                  name="setup-launcher"
                  value="agency"
                  checked={setupLauncher === 'agency'}
                  onChange={() => setSetupLauncher('agency')}
                />
                <span>
                  <code>agency copilot --acp</code>
                  <span className="setupScriptLauncherDesc">Launches Copilot through the Microsoft <code>agency</code> wrapper. Installed via <code>aka.ms/InstallTool.ps1</code> if missing.</span>
                </span>
              </label>
            </fieldset>
            <div className="setupScriptActions">
              <button className="ghostButton setupDownloadBtn" onClick={() => downloadSetupZip(setupLauncher)}>
                📦 Download copilot-node-setup.zip
              </button>
              <button className="ghostButton" onClick={() => setShowSetupScript(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add relay agent modal ── */}
      {!mobileRestricted && showAddRelayAgent && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal" role="dialog" aria-modal="true" aria-label={`Add Agent on ${relayAgentNode}`}>
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
