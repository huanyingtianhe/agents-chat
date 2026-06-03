export type AgentModel = {
  modelId: string;
  name?: string;
  description?: string;
};

export type AgentAuthMethod = {
  id: string;
  name?: string;
  description?: string;
};

export type Agent = {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  yolo?: boolean;
  env?: Record<string, string>;
  relay?: boolean;
  relayConnectionName?: string;
  relayConnectionLabel?: string;
  owner?: string;
  canModify?: boolean;
  canTalk?: boolean;
  public?: boolean;
  models?: AgentModel[];
  defaultModelId?: string;
  authMethods?: AgentAuthMethod[];
  needsAuth?: boolean;
};
