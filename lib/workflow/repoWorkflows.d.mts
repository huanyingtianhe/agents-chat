import type { WorkflowPlan } from './workflowTypes';

export interface RepoWorkflow {
  name: string;
  source: 'repo';
  filePath: string;
  plan: WorkflowPlan;
}

export declare function loadRepoWorkflows(): Promise<RepoWorkflow[]>;
