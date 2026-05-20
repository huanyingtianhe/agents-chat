export type PtyPhase = 'booting' | 'loading-environment' | 'idle-ready' | 'thinking' | 'replying';

export const AUTO_MAX_STEPS = 5;

export class PromptSendFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptSendFailedError';
  }
}

export function mapTurnPhase(phase: string): PtyPhase | undefined {
  switch (phase) {
    case 'booting':
      return 'loading-environment';
    case 'thinking':
      return 'thinking';
    case 'tool_exec':
      return 'thinking';
    case 'replying':
      return 'replying';
    case 'done':
      return 'idle-ready';
    default:
      return undefined;
  }
}

export function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
