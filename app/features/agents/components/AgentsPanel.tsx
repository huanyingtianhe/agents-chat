'use client';

import type { Agent } from '../agentTypes';
import type { NodeData } from '../../nodes/nodeTypes';
import type { AccessEntry } from '../hooks/useAgentPanelState';
import { useAgentPanelState } from '../hooks/useAgentPanelState';
import { AgentModelSelect } from './AgentModelSelect';
import { AgentAuthControl } from './AgentAuthControl';
import './AgentAuthControl.css';

function getAgentLocationLabel(agent: Agent): string {
  if (!agent.relay) return `@${agent.id}`;
  const nodeId = agent.relayConnectionName || agent.id;
  return `🌐 ${agent.relayConnectionLabel?.trim() || nodeId}`;
}

function getAgentLocationTitle(agent: Agent): string | undefined {
  if (!agent.relay) return undefined;
  return agent.relayConnectionName || agent.id;
}

export interface AgentsPanelProps {
  panelState: ReturnType<typeof useAgentPanelState>;
  agents: (Agent & { running?: boolean })[];
  agentsLoading: boolean;
  isAdmin: boolean;
  nodesData: NodeData[];
  selectedAgentFilter: string | null;
  selectedAgentModels: Record<string, string>;
  ensuringAgentModels: Record<string, boolean>;
  setSelectedModelForAgent: (agentId: string, modelId: string) => void;
  reloadAgents: () => void | Promise<void>;
}

export function AgentsPanel({
  panelState,
  agents,
  agentsLoading,
  isAdmin,
  nodesData,
  selectedAgentFilter,
  selectedAgentModels,
  ensuringAgentModels,
  setSelectedModelForAgent,
  reloadAgents,
}: AgentsPanelProps) {
  const {
    showAgentsPanel,
    setShowAgentsPanel,
    showAgentAddMenu,
    setShowAgentAddMenu,
    showAddAgent,
    newAgentForm,
    setNewAgentForm,
    addAgentLoading,
    openAddAgent,
    closeAddAgent,
    createAgent,
    showAddRemoteAgent,
    setShowAddRemoteAgent,
    newRemoteAgentForm,
    setNewRemoteAgentForm,
    openAddRemoteAgent,
    createRemoteAgent,
    showAgentSettings,
    settingsAgentId,
    settingsAgentConfig,
    setSettingsAgentConfig,
    settingsEnvText,
    setSettingsEnvText,
    agentSettingsLoading,
    agentAccessList,
    newAccessEmail,
    setNewAccessEmail,
    closeAgentSettings,
    saveAgentSettings,
    deleteAgent,
    addAccess,
    removeAccess,
    openAgentSettings,
    openModelMenuAgentId,
    setOpenModelMenuAgentId,
    modelMenuRefs,
  } = panelState;

  return (
    <>
      {/* ── Right sidebar: agents ── */}
      {showAgentsPanel && (
        <aside className={`agentsSidebar ${showAgentsPanel ? 'mobilePanelVisible' : ''}`}>
          <div className="agentsSidebarHeader">
            <span>Agents</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <div style={{ position: 'relative' }}>
                <button className="sidebarToggle" onClick={() => setShowAgentAddMenu(p => !p)} title="Add agent">+</button>
                {showAgentAddMenu && (
                  <div className="nodeAddMenu">
                    {isAdmin && (
                      <button className="nodeAddMenuItem" onClick={openAddAgent}>
                        🖥️ Add Agent in Server
                      </button>
                    )}
                    <button className="nodeAddMenuItem" onClick={openAddRemoteAgent}>
                      🌐 Add Agent from Remote Node
                    </button>
                    <button className="nodeAddMenuItem" onClick={() => setShowAgentAddMenu(false)}>
                      ✕ Cancel
                    </button>
                  </div>
                )}
              </div>
              <button className="sidebarToggle" onClick={() => setShowAgentsPanel(false)}>→</button>
            </div>
          </div>
          <div className="agentsSidebarSection">
            {agents.map((agent) => (
              <button
                key={agent.id}
                className="agentListItem"
                style={agent.canModify ? undefined : { cursor: 'default' }}
                onClick={() => agent.canModify && openAgentSettings(agent.id)}
                title={agent.canModify ? `${agent.name} — Click for settings` : agent.name}
              >
                <span className="agentListAvatar">{(agent.name || agent.id).slice(0, 1).toUpperCase()}</span>
                <span className="agentListInfo">
                  <span className="agentListName">{agent.name || agent.id}{agent.canTalk === false ? ' 🔒' : ''}</span>
                  <span className="agentListId" title={getAgentLocationTitle(agent)}>{getAgentLocationLabel(agent)}</span>
                </span>
                <AgentAuthControl agent={agent} onAuthenticated={() => void reloadAgents()} />
                <span className={`agentListStatus ${agent.running ? 'running' : ''}`}>{agent.running ? '●' : '○'}</span>
              </button>
            ))}
            {agents.length === 0 && (
              <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
                {agentsLoading ? 'Loading...' : 'No agents configured'}
              </div>
            )}
          </div>
          {(() => {
            if (!selectedAgentFilter) return null;
            const activeAgent = agents.find((a) => a.id === selectedAgentFilter);
            const models = activeAgent?.models || [];
            if (!models.length) return null;
            return (
              <div className="agentSidebarModelRow">
                <span className="agentSidebarModelLabel">Model</span>
                <AgentModelSelect
                  agentId={activeAgent!.id}
                  models={models}
                  selectedModelId={selectedAgentModels[activeAgent!.id] || ''}
                  isOpen={openModelMenuAgentId === activeAgent!.id}
                  onToggle={() => setOpenModelMenuAgentId((p) => (p === activeAgent!.id ? null : activeAgent!.id))}
                  onSelectModel={(modelId) => {
                    setSelectedModelForAgent(activeAgent!.id, modelId);
                    setOpenModelMenuAgentId(null);
                  }}
                  wrapRef={(el) => modelMenuRefs.current.set(activeAgent!.id, el)}
                  isEnsuring={ensuringAgentModels[activeAgent!.id]}
                />
              </div>
            );
          })()}
        </aside>
      )}

      {/* ── Add remote agent modal ── */}
      {showAddRemoteAgent && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal">
            <h2>🌐 Add Agent from Remote Node</h2>
            <label>
              <span>Agent ID</span>
              <input value={newRemoteAgentForm.id} onChange={(e) => setNewRemoteAgentForm(f => ({ ...f, id: e.target.value }))} placeholder="unique-agent-id" />
              <span className="fieldHint">Unique identifier, lowercase with hyphens</span>
            </label>
            <label>
              <span>Agent Name</span>
              <input value={newRemoteAgentForm.name} onChange={(e) => setNewRemoteAgentForm(f => ({ ...f, name: e.target.value }))} placeholder="My Remote Agent" />
              <span className="fieldHint">Display name for the agent</span>
            </label>
            <label>
              <span>Node</span>
              <select value={newRemoteAgentForm.nodeName} onChange={(e) => setNewRemoteAgentForm(f => ({ ...f, nodeName: e.target.value }))} className="remoteAgentSelect">
                <option value="">— Select a node —</option>
                {nodesData.map(n => (
                  <option key={n.name} value={n.name}>{n.label} ({n.name}){n.online ? '' : ' · offline'}</option>
                ))}
              </select>
              <span className="fieldHint">The remote node to run the agent on</span>
            </label>
            <label>
              <span>Working Directory (on the remote node)</span>
              <input value={newRemoteAgentForm.cwd} onChange={(e) => setNewRemoteAgentForm(f => ({ ...f, cwd: e.target.value }))} placeholder="/home/user/project or C:\Repos\MyProject" />
              <span className="fieldHint">The cwd the copilot agent runs in on that node</span>
            </label>
            <div className="modalActions">
              <button className="primary" onClick={() => void createRemoteAgent()} disabled={addAgentLoading || !newRemoteAgentForm.id.trim() || !newRemoteAgentForm.nodeName}>
                {addAgentLoading ? 'Creating...' : 'Create Remote Agent'}
              </button>
              <button className="secondary" onClick={() => setShowAddRemoteAgent(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Agent settings modal (admin or owner) ── */}
      {showAgentSettings && settingsAgentConfig && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal agentConfigurationModal">
            <h2>⚙️ {settingsAgentConfig.name}</h2>
            <label>
              <span>Agent ID</span>
              <input value={settingsAgentConfig.id} disabled style={{ opacity: 0.6 }} />
              <span className="fieldHint">Unique identifier (read-only)</span>
            </label>
            <label>
              <span>Name</span>
              <input value={settingsAgentConfig.name} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, name: e.target.value } : c)} />
            </label>
            {settingsAgentConfig.relay ? (
              <>
                <label>
                  <span>Node</span>
                  <input value={settingsAgentConfig.relayConnectionName || ''} disabled style={{ opacity: 0.6 }} />
                  <span className="fieldHint">Remote node this agent runs on</span>
                </label>
                <label>
                  <span>Working Directory (on the remote node)</span>
                  <input value={settingsAgentConfig.cwd} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, cwd: e.target.value } : c)} />
                </label>
              </>
            ) : (
              <>
                <label>
                  <span>Command</span>
                  <input value={settingsAgentConfig.command} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, command: e.target.value } : c)} />
                  <span className="fieldHint">Path to the ACP executable</span>
                </label>
                <label>
                  <span>Arguments</span>
                  <input value={(settingsAgentConfig.args || []).join(' ')} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, args: e.target.value.split(/\s+/).filter(Boolean) } : c)} />
                  <span className="fieldHint">Space-separated args (e.g. --acp --yolo)</span>
                </label>
                <label>
                  <span>Working Directory</span>
                  <input value={settingsAgentConfig.cwd} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, cwd: e.target.value } : c)} />
                </label>
                <label className="checkboxLabel">
                  <input type="checkbox" checked={settingsAgentConfig.yolo} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, yolo: e.target.checked } : c)} />
                  <span>YOLO mode (auto-approve)</span>
                </label>
                {!settingsAgentConfig.relay && (
                  <label>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      Environment Variables
                      <button
                        type="button"
                        onClick={(e) => {
                          const textarea = (e.currentTarget.closest('label') as HTMLElement)?.querySelector('textarea');
                          if (textarea) textarea.style.filter = textarea.style.filter ? '' : 'blur(4px)';
                        }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', padding: 0 }}
                        title="Toggle visibility"
                      >👁</button>
                    </span>
                    <textarea
                      value={settingsEnvText}
                      onChange={(e) => setSettingsEnvText(e.target.value)}
                      placeholder={"ANTHROPIC_API_KEY=sk-ant-...\nOTHER_VAR=value"}
                      rows={3}
                      style={{ fontFamily: 'monospace' }}
                    />
                    <span className="fieldHint">One per line: KEY=VALUE. Used for API keys and agent config.</span>
                  </label>
                )}
              </>
            )}
            <div style={{ marginTop: '16px', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: '12px' }}>
              <h3 style={{ margin: '0 0 8px', fontSize: '13px', color: '#8a90a2' }}>🔐 Access Control</h3>
              <label className="checkboxLabel" style={{ marginBottom: '8px' }}>
                <input type="checkbox" checked={!!settingsAgentConfig.public} onChange={(e) => setSettingsAgentConfig((c) => c ? { ...c, public: e.target.checked } : c)} />
                <span>Public (anyone can talk to this agent)</span>
              </label>
              {!settingsAgentConfig.public && (
                <>
                  <p style={{ fontSize: '12px', color: '#666', margin: '0 0 8px' }}>Only listed users (and admins) can talk to this agent.</p>
                  <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
                    <input
                      value={newAccessEmail}
                      onChange={(e) => setNewAccessEmail(e.target.value)}
                      placeholder="user@email.com"
                      style={{ flex: 1 }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addAccess(); } }}
                    />
                    <button className="primary inlinePrimary" onClick={() => void addAccess()} disabled={!newAccessEmail.trim()}>Grant</button>
                  </div>
                  {agentAccessList.length > 0 ? (
                    <div style={{ maxHeight: '120px', overflowY: 'auto', fontSize: '12px' }}>
                      {(agentAccessList as AccessEntry[]).map((entry) => (
                        <div key={entry.email} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                          <span>{entry.email}</span>
                          <button onClick={() => void removeAccess(entry.email)} style={{ fontSize: '11px', padding: '2px 6px', background: 'transparent', color: '#e55', border: '1px solid #e55', borderRadius: '3px', cursor: 'pointer' }}>✕</button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize: '12px', color: '#666', fontStyle: 'italic' }}>No users granted access yet. Only the owner and admins can talk to this agent.</div>
                  )}
                </>
              )}
            </div>
            <div className="modalActions">
              <button className="primary" onClick={() => void saveAgentSettings()} disabled={agentSettingsLoading}>{agentSettingsLoading ? 'Saving...' : 'Save'}</button>
              <button className="secondary" onClick={closeAgentSettings}>Cancel</button>
              <button className="danger" style={{ marginLeft: 'auto' }} onClick={() => settingsAgentId && void deleteAgent(settingsAgentId, settingsAgentConfig.name)} disabled={agentSettingsLoading}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {showAgentSettings && !settingsAgentConfig && agentSettingsLoading && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal">
            <div style={{ textAlign: 'center', padding: '20px', color: '#8a90a2' }}>Loading...</div>
          </div>
        </div>
      )}

      {/* ── Add agent modal ── */}
      {showAddAgent && (
        <div className="modalOverlay">
          <div className="modal agentSettingsModal">
            <h2>➕ Add New Agent</h2>
            <label>
              <span>Agent ID</span>
              <input value={newAgentForm.id} onChange={(e) => setNewAgentForm((f) => ({ ...f, id: e.target.value }))} placeholder="unique-agent-id" />
              <span className="fieldHint">Unique identifier, lowercase with hyphens</span>
            </label>
            <label>
              <span>Display Name</span>
              <input value={newAgentForm.name} onChange={(e) => setNewAgentForm((f) => ({ ...f, name: e.target.value }))} placeholder="My Agent" />
            </label>
            <label>
              <span>Command</span>
              <input value={newAgentForm.command} onChange={(e) => setNewAgentForm((f) => ({ ...f, command: e.target.value }))} placeholder="copilot.exe" />
              <span className="fieldHint">Path to the ACP executable</span>
            </label>
            <label>
              <span>Arguments</span>
              <input value={newAgentForm.args} onChange={(e) => setNewAgentForm((f) => ({ ...f, args: e.target.value }))} placeholder="--acp" />
              <span className="fieldHint">Space-separated args</span>
            </label>
            <label>
              <span>Working Directory</span>
              <input value={newAgentForm.cwd} onChange={(e) => setNewAgentForm((f) => ({ ...f, cwd: e.target.value }))} placeholder="C:\path\to\project" />
            </label>
            <label className="checkboxLabel">
              <input type="checkbox" checked={newAgentForm.yolo} onChange={(e) => setNewAgentForm((f) => ({ ...f, yolo: e.target.checked }))} />
              <span>YOLO mode (auto-approve)</span>
            </label>
            <label>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                Environment Variables
                <button
                  type="button"
                  onClick={(e) => {
                    const textarea = (e.currentTarget.closest('label') as HTMLElement)?.querySelector('textarea');
                    if (textarea) textarea.style.filter = textarea.style.filter ? '' : 'blur(4px)';
                  }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', padding: 0 }}
                  title="Toggle visibility"
                >👁</button>
              </span>
              <textarea
                value={newAgentForm.env}
                onChange={(e) => setNewAgentForm((f) => ({ ...f, env: e.target.value }))}
                placeholder={"ANTHROPIC_API_KEY=sk-ant-...\nOTHER_VAR=value"}
                rows={3}
                style={{ fontFamily: 'monospace', fontSize: '12px' }}
              />
              <span className="fieldHint">One per line: KEY=VALUE. Used for API keys and agent config.</span>
            </label>
            <div className="modalActions">
              <button className="primary" onClick={() => void createAgent()} disabled={addAgentLoading || !newAgentForm.id.trim()}>
                {addAgentLoading ? 'Creating...' : 'Create Agent'}
              </button>
              <button className="secondary" onClick={closeAddAgent}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
