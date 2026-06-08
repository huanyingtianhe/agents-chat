import type { WorkflowPlan } from './workflowTypes';

export interface AgentDescriptor {
  id: string;
  description: string;
}

export interface PlanPromptArgs {
  userMessage: string;
  agents: AgentDescriptor[];
}

export interface ReplanPromptArgs extends PlanPromptArgs {
  originalPlan: WorkflowPlan;
  failedNodeId: string;
  failureMessage: string;
  completedOutputs: Record<string, string>;
}

export type ParseResult =
  | { ok: true; plan: WorkflowPlan }
  | { ok: false; error: string };

export declare function buildPlanPrompt(args: PlanPromptArgs): string;
export declare function buildReplanPrompt(args: ReplanPromptArgs): string;
export declare function parseSchedulerPlanResponse(raw: string): ParseResult;
