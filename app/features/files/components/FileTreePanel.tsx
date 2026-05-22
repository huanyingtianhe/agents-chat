'use client';

import type { ReactNode } from 'react';
import type { Agent } from '../../agents/agentTypes';
import { getFileIcon } from '../fileWorkspaceHelpers';
import type { FileTreeNode } from '../fileWorkspaceTypes';
import type { UseFileWorkspaceStateResult } from '../hooks/useFileWorkspaceState';
import { SelectPicker } from '../../ui/SelectPicker';

type FileTreePanelProps = {
  workspace: UseFileWorkspaceStateResult;
  agents: Agent[];
  schedulerAgentId: string;
};

export function FileTreePanel({ workspace, agents, schedulerAgentId }: FileTreePanelProps) {
  const renderNodes = (nodes: FileTreeNode[], depth: number): ReactNode[] => {
    return nodes.map(node => {
      if (node.isDir) {
        const expanded = workspace.mdExpandedDirs.has(node.path);
        return (
          <div key={node.path}>
            <button
              className="mdTreeDir"
              style={{ paddingLeft: `${depth * 14}px` }}
              onClick={() => workspace.toggleMdDir(node.path)}
            >
              <span className="mdTreeArrow">{expanded ? '▾' : '▸'}</span>
              <span className="mdTreeDirIcon">📁</span>
              <span className="mdTreeLabel">{node.name}</span>
            </button>
            {expanded && node.children.length > 0 && renderNodes(node.children, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={node.path}
          className={`mdTreeFile ${workspace.mdSelectedFile === node.path ? 'active' : ''}`}
          style={{ paddingLeft: `${depth * 14}px` }}
          title={node.path}
          onClick={() => void workspace.openMdFile(node.path)}
        >
          <span className="mdTreeFileIcon">{getFileIcon(node.name)}</span>
          <span className="mdTreeLabel">{node.name}</span>
        </button>
      );
    });
  };

  return (
    <div className="mdFilesTab">
      <div style={{ padding: '4px 0 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="remoteAgentPickerSlot">
          <SelectPicker
            options={[
              { value: '', label: 'Select agent…' },
              ...agents
                .filter(a => a.cwd && !a.relay && a.id !== schedulerAgentId)
                .map(a => ({ value: a.id, label: `${a.canTalk === false ? '🔒 ' : ''}${a.name || a.id}` })),
            ]}
            value={workspace.mdSelectedAgentId || ''}
            ariaLabel="Files agent"
            onChange={(v) => workspace.selectMdAgent(v || null)}
          />
        </div>
        <button
          className={`mdDiffToggle ${workspace.mdDiffOnly ? 'active' : ''}`}
          title={workspace.mdDiffOnly ? 'Showing changed files (git diff)' : 'Show only changed files'}
          onClick={workspace.toggleMdDiffOnly}
        >
          {workspace.mdDiffOnly ? '🔀 Changed' : '🔀 Diff'}
        </button>
      </div>
      <div className="mdFilesList">
        {workspace.mdFilesLoading && <div className="muted" style={{ padding: 16, textAlign: 'center' }}>Loading…</div>}
        {!workspace.mdFilesLoading && workspace.mdFilesError === 'unauthorized' && (
          <div className="muted" style={{ padding: 16, textAlign: 'center' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
            <div>Not authorized</div>
            <div style={{ fontSize: 11, marginTop: 4 }}>You don&apos;t have access to this agent&apos;s files</div>
          </div>
        )}
        {!workspace.mdFilesLoading && !workspace.mdFilesError && workspace.mdSelectedAgentId && workspace.mdFilesList.length === 0 && (
          <div className="muted" style={{ padding: 16, textAlign: 'center' }}>{workspace.mdDiffOnly ? 'No changed files' : 'No files found'}</div>
        )}
        {!workspace.mdFilesLoading && workspace.mdFileTree.length > 0 && (
          <div className="mdTree">{renderNodes(workspace.mdFileTree, 0)}</div>
        )}
      </div>
    </div>
  );
}
