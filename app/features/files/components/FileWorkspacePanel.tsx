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
  mobileReadOnly: boolean;
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
    return (
      <>
        {props.workspace.mdFileError ? (
          <div className="fileWorkspaceError" role="alert">
            {props.workspace.mdFileError}
          </div>
        ) : null}
        <FileTreePanel workspace={props.workspace} agents={props.agents} schedulerAgentId={props.schedulerAgentId} />
      </>
    );
  }

  const { workspace, comments, selection, mobileReadOnly } = props;
  if (!workspace.mdEditorOpen || !workspace.mdSelectedFile) return null;

  return (
    <div className="mdEditorInline">
      <FileEditorPanel workspace={workspace} comments={comments} selection={selection} mobileReadOnly={mobileReadOnly} />
      <FileCommentSidebar comments={comments} selection={selection} />
    </div>
  );
}
