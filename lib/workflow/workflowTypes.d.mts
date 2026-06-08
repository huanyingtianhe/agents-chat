export type NodeStatus = 'pending' | 'running' | 'awaiting-input' | 'ok' | 'failed' | 'skipped';

export interface WorkflowNode {
  id: string;
  agent: string;
  instruction: string;
  dependsOn: string[];
}

export interface WorkflowPlan {
  name?: string;
  version: 1;
  nodes: WorkflowNode[];
}

export interface ExecutionState {
  planId: string;
  plan: WorkflowPlan;
  nodeStatuses: Record<string, NodeStatus>;
  nodeOutputs: Record<string, string>;
  failureReason?: string;
}

export type SchemaErrorCode =
  | 'not_object'
  | 'missing_field'
  | 'wrong_type'
  | 'duplicate_node_id'
  | 'unknown_dependency'
  | 'cycle'
  | 'empty_nodes'
  | 'unknown_template_ref';

export interface SchemaError {
  code: SchemaErrorCode;
  message: string;
  nodeId?: string;
  field?: string;
}

export type SchemaResult =
  | { ok: true; plan: WorkflowPlan }
  | { ok: false; error: SchemaError };
