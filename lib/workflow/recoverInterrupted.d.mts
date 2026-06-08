export const RELOAD_RECOVERY_PROMPT: string;
export function isTerminalStatus(status: string): boolean;
export function recoverInterruptedOrchestration<T>(state: T): T;
