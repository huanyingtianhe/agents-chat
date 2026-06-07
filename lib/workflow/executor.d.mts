import type { WorkflowPlan, WorkflowNode, NodeStatus, ExecutionState } from './workflowTypes';

export type Dispatcher = (node: WorkflowNode, renderedInstruction: string) => Promise<string>;

export interface ExecutorOptions {
  planId?: string;
  onStatusChange?: (
    nodeId: string,
    status: NodeStatus,
    output?: string,
    error?: string,
  ) => void;
  initialState?: ExecutionState;
}

export declare function runWorkflow(
  plan: WorkflowPlan,
  userInput: string,
  dispatch: Dispatcher,
  opts?: ExecutorOptions,
): Promise<ExecutionState>;
