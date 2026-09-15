export type AgentModelMenuSurface = 'composer' | 'panel';

export function getAgentModelMenuKey(
  surface: AgentModelMenuSurface,
  agentId: string,
): string {
  return `${surface}:${agentId}`;
}
