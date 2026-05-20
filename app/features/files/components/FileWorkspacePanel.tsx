'use client';

import { FileCommentSidebar } from './FileCommentSidebar';
import { FileEditorPanel } from './FileEditorPanel';
import { FileTreePanel } from './FileTreePanel';
import type { UseFileCommentsResult } from '../hooks/useFileComments';
import type { UseFileWorkspaceStateResult } from '../hooks/useFileWorkspaceState';
import type { UseLiveEditorSelectionResult } from '../hooks/useLiveEditorSelection';
import type { Agent } from '../../agents/agentTypes';

type FileWorkspaceEditorProps = {
  variant?: 'editor';
  workspace: UseFileWorkspaceStateResult;
  comments: UseFileCommentsResult;
  selection: UseLiveEditorSelectionResult;
};

type FileWorkspaceTreeProps = {
  variant: 'tree';
  workspace: UseFileWorkspaceStateResult;
  agents: Agent[];
  schedulerAgentId: string;
  comments?: never;
  selection?: never;
};

type FileWorkspacePanelProps = FileWorkspaceEditorProps | FileWorkspaceTreeProps;

export function FileWorkspacePanel(props: FileWorkspacePanelProps) {
  if (props.variant === 'tree') {
    return <FileTreePanel workspace={props.workspace} agents={props.agents} schedulerAgentId={props.schedulerAgentId} />;
  }

  const { workspace, comments, selection } = props;
  if (!workspace.mdEditorOpen || !workspace.mdSelectedFile) return null;

  return (
    <div className="mdEditorInline">
      <FileEditorPanel workspace={workspace} comments={comments} selection={selection} />
      <FileCommentSidebar comments={comments} selection={selection} />
    </div>
  );
}
