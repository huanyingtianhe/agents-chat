import { spawn, ChildProcess } from 'child_process';

/* ─────────────── Terminal Management ─────────────── */

export type ManagedTerminal = {
  cp: ChildProcess;
  output: string;
  exitCode: number | null;
  signal: string | null;
  done: boolean;
  waiters: Array<(info: { exitCode: number | null; signal: string | null }) => void>;
};

export const globalTerminals = globalThis as typeof globalThis & {
  __acpTerminals?: Map<string, ManagedTerminal>;
  __acpNextTermId?: number;
};

export function getTerminals(): Map<string, ManagedTerminal> {
  if (!globalTerminals.__acpTerminals) {
    globalTerminals.__acpTerminals = new Map();
  }
  return globalTerminals.__acpTerminals;
}

export function handleTerminalCreate(params: Record<string, unknown>, cwd: string): { terminalId: string } {
  const id = `term-${(globalTerminals.__acpNextTermId = (globalTerminals.__acpNextTermId ?? 0) + 1)}`;
  const command = String(params.command ?? (process.platform === 'win32' ? 'cmd' : 'bash'));
  const args = (params.args as string[] | undefined) ?? [];
  const termCwd = String(params.cwd ?? cwd ?? process.cwd());
  console.log(`[ACP-TERM] create ${id}: ${command} ${args.join(' ')} (cwd: ${termCwd})`);

  const cp = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: termCwd,
    env: process.env,
    shell: true,
  });

  const terminal: ManagedTerminal = { cp, output: '', exitCode: null, signal: null, done: false, waiters: [] };

  const MAX_TERM_OUTPUT = 100_000; // 100KB cap per terminal
  cp.stdout?.on('data', (chunk: Buffer) => {
    terminal.output += chunk.toString();
    if (terminal.output.length > MAX_TERM_OUTPUT) terminal.output = terminal.output.slice(-MAX_TERM_OUTPUT);
  });
  cp.stderr?.on('data', (chunk: Buffer) => {
    terminal.output += chunk.toString();
    if (terminal.output.length > MAX_TERM_OUTPUT) terminal.output = terminal.output.slice(-MAX_TERM_OUTPUT);
  });
  cp.on('exit', (code, signal) => {
    terminal.exitCode = code;
    terminal.signal = signal;
    terminal.done = true;
    for (const w of terminal.waiters) w({ exitCode: code, signal });
    terminal.waiters = [];
    console.log(`[ACP-TERM] ${id} exited (code=${code})`);
    // Auto-cleanup finished terminal after 5 min to prevent memory leak
    setTimeout(() => { getTerminals().delete(id); }, 5 * 60_000);
  });
  cp.on('error', (err) => {
    console.error(`[ACP-TERM] ${id} spawn error:`, err.message);
    terminal.done = true;
    terminal.exitCode = -1;
    for (const w of terminal.waiters) w({ exitCode: -1, signal: null });
    terminal.waiters = [];
  });

  getTerminals().set(id, terminal);
  return { terminalId: id };
}

export function handleTerminalOutput(params: Record<string, unknown>): { output: string; done: boolean; exitCode: number | null } {
  const id = String(params.terminalId ?? '');
  const terminal = getTerminals().get(id);
  if (!terminal) return { output: '', done: true, exitCode: -1 };
  const out = terminal.output;
  terminal.output = '';
  return { output: out, done: terminal.done, exitCode: terminal.exitCode };
}

export async function handleTerminalWaitForExit(params: Record<string, unknown>): Promise<{ exitCode: number | null; signal: string | null }> {
  const id = String(params.terminalId ?? '');
  const terminal = getTerminals().get(id);
  if (!terminal) return { exitCode: -1, signal: null };
  if (terminal.done) return { exitCode: terminal.exitCode, signal: terminal.signal };
  return new Promise((resolve) => { terminal.waiters.push(resolve); });
}

export function handleTerminalRelease(params: Record<string, unknown>): Record<string, unknown> {
  const id = String(params.terminalId ?? '');
  getTerminals().delete(id);
  return {};
}

export function handleTerminalKill(params: Record<string, unknown>): Record<string, unknown> {
  const id = String(params.terminalId ?? '');
  const terminal = getTerminals().get(id);
  if (terminal && !terminal.done) {
    try { terminal.cp.kill(); } catch { /* ignore */ }
  }
  return {};
}
