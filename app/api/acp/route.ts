import { NextRequest, NextResponse } from 'next/server';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { getToken } from 'next-auth/jwt';
import { updateChatAgentSession, getChat, saveChat } from '@/lib/chatStore';
import { isAdminToken, getUserEmail, canModify, getAuthToken } from '@/lib/auth';
import * as configStore from '@/lib/configStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ACP (Agent Client Protocol) backend for multiple ACP agents.
 *
 * Agents are configured in agents.json at the project root.
 * Each agent is a persistent child process communicating via NDJSON-RPC over stdio.
 */

/* ─────────────────────── Types ─────────────────────── */

type TurnPhase = 'booting' | 'thinking' | 'tool_exec' | 'replying' | 'done';

type TurnEvent = {
  type: 'thinking' | 'tool_start' | 'tool_complete' | 'text_chunk';
  ts: number;
  toolName?: string;
  toolCallId?: string;
  toolArgs?: string;
  toolResult?: string;
  text?: string;
};

type TurnState = {
  id: string;
  prompt: string;
  startedAt: number;
  fullText: string;
  done: boolean;
  phase: TurnPhase;
  statusText: string;
  error?: string;
  events: TurnEvent[];
};

type AgentConfig = {
  id: string;
  name: string;
  command: string;
  args?: string[];
  cwd: string;
  yolo: boolean;
  noTools?: boolean;
  relay?: boolean;
  relayConnectionName?: string;
};

/* ─────────── Minimal NDJSON-RPC over raw Node streams ─────────── */

type PendingRequest = {
  resolve: (result: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  reject: (err: Error) => void;
};

type NdjsonRpc = {
  kind: 'local' | 'relay';
  send: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  respond: (id: number | string, result: Record<string, unknown>) => void;
  /** Write a raw NDJSON line (for fallback cancel). */
  writeRaw: (line: string) => void;
  onNotification: ((method: string, params: any) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  onRequest: ((method: string, params: any, id: number | string) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  onClose: ((reason: string) => void) | null;
  destroy: () => void;
};

function createNdjsonRpc(cp: ChildProcess): NdjsonRpc {
  let nextId = 0;
  const pending = new Map<number, PendingRequest>();
  let buf = '';

  const rpc: NdjsonRpc = {
    kind: 'local',
    onNotification: null,
    onRequest: null,
    onClose: null,

    send(method, params, timeoutMs?: number) {
      const id = ++nextId;
      const msg = JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n';
      console.log(`[ACP] → ${method} (id=${id})`);
      cp.stdin!.write(msg);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const ms = timeoutMs ?? (method === 'session/prompt' ? 0 : 120_000);
        if (ms > 0) {
          setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              reject(new Error(`ACP timeout: ${method}`));
            }
          }, ms);
        }
      });
    },

    respond(id, result) {
      const msg = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
      cp.stdin!.write(msg);
    },

    writeRaw(line: string) {
      cp.stdin!.write(line + '\n');
    },

    destroy() {
      for (const p of pending.values()) p.reject(new Error('ACP destroyed'));
      pending.clear();
      try { cp.kill(); } catch { /* ignore */ }
    },
  };

  cp.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      // Force a flat string copy to avoid V8 SlicedString retaining the original large buf
      if (buf.length > 0) buf = (' ' + buf).slice(1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if ('method' in msg && 'id' in msg && msg.id != null) {
          rpc.onRequest?.(msg.method, msg.params, msg.id);
        } else if ('method' in msg) {
          rpc.onNotification?.(msg.method, msg.params);
        } else if ('id' in msg) {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            if (msg.error) {
              p.reject(new Error(JSON.stringify(msg.error)));
            } else {
              p.resolve(msg.result);
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }
  });

  return rpc;
}

/* ─────────────── Relay NDJSON-RPC (Azure Relay WebSocket) ─────────────── */

const RELAY_SEND_CONNECTION_STRING = process.env.RELAY_SEND_CONNECTION_STRING || '';

function createRelayNdjsonRpc(connectionName: string): Promise<NdjsonRpc> {
  // Dynamic import to keep hyco-ws out of client bundles
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const HycoWebSocket = require('hyco-ws');

  const ns = RELAY_SEND_CONNECTION_STRING.match(/Endpoint=sb:\/\/([^/;]+)/)?.[1];
  const keyName = RELAY_SEND_CONNECTION_STRING.match(/SharedAccessKeyName=([^;]+)/)?.[1];
  const key = RELAY_SEND_CONNECTION_STRING.match(/SharedAccessKey=([^;]+)/)?.[1];
  if (!ns || !keyName || !key) throw new Error('Invalid RELAY_SEND_CONNECTION_STRING');

  const uri = HycoWebSocket.createRelaySendUri(ns, connectionName);
  const token = HycoWebSocket.createRelayToken(uri, keyName, key);

  return new Promise((resolveRpc, rejectRpc) => {
    let nextId = 0;
    const pending = new Map<number, PendingRequest>();
    let buf = '';
    let connected = false;

    const ws = HycoWebSocket.relayedConnect(uri, token);

    function processBuffer() {
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (buf.length > 0) buf = (' ' + buf).slice(1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if ('method' in msg && 'id' in msg && msg.id != null) {
            rpc.onRequest?.(msg.method, msg.params, msg.id);
          } else if ('method' in msg) {
            rpc.onNotification?.(msg.method, msg.params);
          } else if ('id' in msg) {
            const p = pending.get(msg.id);
            if (p) {
              pending.delete(msg.id);
              if (msg.error) {
                p.reject(new Error(JSON.stringify(msg.error)));
              } else {
                p.resolve(msg.result);
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }
    }

    const rpc: NdjsonRpc = {
      kind: 'relay',
      onNotification: null,
      onRequest: null,
      onClose: null,

      send(method, params, timeoutMs?: number) {
        const id = ++nextId;
        const msg = JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n';
        console.log(`[ACP-RELAY] → ${method} (id=${id})`);
        ws.send(msg);
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          const ms = timeoutMs ?? (method === 'session/prompt' ? 0 : 120_000);
          if (ms > 0) {
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`ACP relay timeout: ${method}`));
              }
            }, ms);
          }
        });
      },

      respond(id, result) {
        const msg = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
        ws.send(msg);
      },

      writeRaw(line: string) {
        ws.send(line + '\n');
      },

      destroy() {
        for (const p of pending.values()) p.reject(new Error('ACP relay destroyed'));
        pending.clear();
        try { ws.close(); } catch { /* ignore */ }
      },
    };

    ws.on('open', () => {
      connected = true;
      console.log(`[ACP-RELAY] Connected to ${connectionName}`);
      resolveRpc(rpc);
    });

    ws.on('message', (data: Buffer | string) => {
      buf += data.toString();
      processBuffer();
    });

    ws.on('close', () => {
      console.log(`[ACP-RELAY] Connection closed: ${connectionName}`);
      for (const p of pending.values()) p.reject(new Error('Relay connection closed'));
      pending.clear();
      rpc.onClose?.('connection closed');
    });

    ws.on('error', (err: Error) => {
      console.error(`[ACP-RELAY] Error: ${err.message}`);
      if (!connected) {
        rejectRpc(err);
      }
      for (const p of pending.values()) p.reject(new Error(`Relay error: ${err.message}`));
      pending.clear();
      rpc.onClose?.(`error: ${err.message}`);
    });
  });
}

/* ─────────────── Terminal Management ─────────────── */

type ManagedTerminal = {
  cp: ChildProcess;
  output: string;
  exitCode: number | null;
  signal: string | null;
  done: boolean;
  waiters: Array<(info: { exitCode: number | null; signal: string | null }) => void>;
};

const globalTerminals = globalThis as typeof globalThis & {
  __acpTerminals?: Map<string, ManagedTerminal>;
  __acpNextTermId?: number;
};

function getTerminals(): Map<string, ManagedTerminal> {
  if (!globalTerminals.__acpTerminals) {
    globalTerminals.__acpTerminals = new Map();
  }
  return globalTerminals.__acpTerminals;
}

function handleTerminalCreate(params: Record<string, unknown>, cwd: string): { terminalId: string } {
  const id = `term-${(globalTerminals.__acpNextTermId = (globalTerminals.__acpNextTermId ?? 0) + 1)}`;
  const command = String(params.command ?? (process.platform === 'win32' ? 'cmd' : 'bash'));
  const args = (params.args as string[] | undefined) ?? [];
  const termCwd = String(params.cwd ?? cwd ?? process.cwd());
  console.log(`[ACP-TERM] create ${id}: ${command} ${args.join(' ')} (cwd: ${termCwd})`);

  const cp = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: termCwd,
    env: process.env,
    windowsHide: true,
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

function handleTerminalOutput(params: Record<string, unknown>): { output: string; done: boolean; exitCode: number | null } {
  const id = String(params.terminalId ?? '');
  const terminal = getTerminals().get(id);
  if (!terminal) return { output: '', done: true, exitCode: -1 };
  const out = terminal.output;
  terminal.output = '';
  return { output: out, done: terminal.done, exitCode: terminal.exitCode };
}

async function handleTerminalWaitForExit(params: Record<string, unknown>): Promise<{ exitCode: number | null; signal: string | null }> {
  const id = String(params.terminalId ?? '');
  const terminal = getTerminals().get(id);
  if (!terminal) return { exitCode: -1, signal: null };
  if (terminal.done) return { exitCode: terminal.exitCode, signal: terminal.signal };
  return new Promise((resolve) => { terminal.waiters.push(resolve); });
}

function handleTerminalRelease(params: Record<string, unknown>): Record<string, unknown> {
  const id = String(params.terminalId ?? '');
  getTerminals().delete(id);
  return {};
}

function handleTerminalKill(params: Record<string, unknown>): Record<string, unknown> {
  const id = String(params.terminalId ?? '');
  const terminal = getTerminals().get(id);
  if (terminal && !terminal.done) {
    try { terminal.cp.kill(); } catch { /* ignore */ }
  }
  return {};
}

/* ─────────────── File System Handlers ─────────────── */

async function handleReadTextFile(params: Record<string, unknown>): Promise<{ content: string }> {
  const filePath = String(params.path ?? '');
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return { content };
  } catch {
    return { content: '' };
  }
}

async function handleWriteTextFile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const filePath = String(params.path ?? '');
  const content = String(params.content ?? '');
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  } catch { /* ignore */ }
  return {};
}

/* ─────────────── agents.json Config (now backed by SQLite via configStore) ─────────────── */

function readAgentsConfig(): AgentConfig[] {
  return configStore.getAllAgents().map(a => ({
    id: a.id,
    name: a.name,
    command: a.command,
    args: a.args,
    cwd: a.cwd,
    yolo: a.yolo,
    noTools: a.noTools,
    relay: a.relay,
    relayConnectionName: a.relayConnectionName,
  }));
}

function getAgentById(agentId: string): AgentConfig | null {
  const a = configStore.getAgentById(agentId);
  if (!a) return null;
  return {
    id: a.id,
    name: a.name,
    command: a.command,
    args: a.args,
    cwd: a.cwd,
    yolo: a.yolo,
    noTools: a.noTools,
    relay: a.relay,
    relayConnectionName: a.relayConnectionName,
  };
}

/* ─────────────── Per-Agent ACP State (Multi-User) ─────────────── */

// Shared per-agent: the process, RPC, and boot state
type AgentProcess = {
  rpc: NdjsonRpc | null;
  ready: boolean;
  booting: boolean;
  error: string | null;
  config: AgentConfig;
  cachedCwd: string;
  supportsLoadSession: boolean;
  knownSessions: Set<string>; // sessions active in agent memory (no need to session/load)
};

// Per-user per-agent: isolated session and turn state
type UserSession = {
  sessionId: string | null;
  /** Map of chatId → list of sessionIds (append-only). Last element is the current session. */
  chatSessions: Map<string, string[]>;
  activeTurn: TurnState | null;
  phase: 'idle' | 'busy' | 'booting';
  turnCount: number;
  lastActive: number;
};

/** Append a sessionId to a chat's session list (skip if already the last entry). */
function pushChatSession(sess: UserSession, chatId: string, sessionId: string): void {
  const list = sess.chatSessions.get(chatId);
  if (list) {
    if (list[list.length - 1] !== sessionId) list.push(sessionId);
  } else {
    sess.chatSessions.set(chatId, [sessionId]);
  }
}

/** Get the current (last) sessionId for a chat, or null. */
function getChatSession(sess: UserSession, chatId: string): string | null {
  const list = sess.chatSessions.get(chatId);
  return list && list.length > 0 ? list[list.length - 1] : null;
}

const globalStore = globalThis as typeof globalThis & {
  __acpAgents?: Map<string, AgentProcess>;
  __acpUserSessions?: Map<string, UserSession>;
  __acpBootPromises?: Map<string, Promise<void>>;
  /** Collects replayed messages during session/load (keyed by sessionId) */
  __acpReplayBuffers?: Map<string, { role: 'user' | 'agent'; text: string }[]>;
};

function getAgentProcesses(): Map<string, AgentProcess> {
  if (!globalStore.__acpAgents) globalStore.__acpAgents = new Map();
  return globalStore.__acpAgents;
}

function getUserSessions(): Map<string, UserSession> {
  if (!globalStore.__acpUserSessions) globalStore.__acpUserSessions = new Map();
  return globalStore.__acpUserSessions;
}

// Periodically clean up stale user sessions (inactive > 30 min)
const STALE_SESSION_MS = 30 * 60_000;
function cleanupStaleSessions() {
  const now = Date.now();
  for (const [key, sess] of getUserSessions()) {
    if (now - sess.lastActive > STALE_SESSION_MS && sess.phase === 'idle') {
      getUserSessions().delete(key);
    }
  }
}
if (!(globalThis as any).__acpCleanupTimer) {
  (globalThis as any).__acpCleanupTimer = setInterval(cleanupStaleSessions, 5 * 60_000);
}

function getBootPromises(): Map<string, Promise<void>> {
  if (!globalStore.__acpBootPromises) globalStore.__acpBootPromises = new Map();
  return globalStore.__acpBootPromises;
}

function getReplayBuffers(): Map<string, { role: 'user' | 'agent'; text: string }[]> {
  if (!globalStore.__acpReplayBuffers) globalStore.__acpReplayBuffers = new Map();
  return globalStore.__acpReplayBuffers;
}

function userSessionKey(agentId: string, userId: string): string {
  return `${agentId}:${userId}`;
}

function getAgentProcess(agentId: string, config: AgentConfig): AgentProcess {
  const procs = getAgentProcesses();
  let proc = procs.get(agentId);
  if (!proc) {
    proc = {
      rpc: null,
      ready: false,
      booting: false,
      error: null,
      config,
      cachedCwd: config.cwd || process.cwd(),
      supportsLoadSession: false,
      knownSessions: new Set(),
    };
    procs.set(agentId, proc);
  }
  return proc;
}

function getUserSession(agentId: string, userId: string): UserSession {
  const sessions = getUserSessions();
  const key = userSessionKey(agentId, userId);
  let sess = sessions.get(key);
  if (!sess) {
    sess = {
      sessionId: null,
      chatSessions: new Map(),
      activeTurn: null,
      phase: 'idle',
      turnCount: 0,
      lastActive: Date.now(),
    };
    sessions.set(key, sess);
  }
  sess.lastActive = Date.now();
  // Ensure chatSessions exists for sessions created before this field was added
  if (!sess.chatSessions) sess.chatSessions = new Map();
  return sess;
}

// Find user session by sessionId (for routing notifications)
function findUserSessionBySessionId(sessionId: string): UserSession | undefined {
  for (const sess of getUserSessions().values()) {
    if (sess.sessionId === sessionId) return sess;
  }
  return undefined;
}

/* ─────────────── ACP Lifecycle ─────────────── */

async function bootAgent(agentId: string): Promise<void> {
  const procs = getAgentProcesses();
  const existing = procs.get(agentId);
  if (existing?.ready) return;

  const promises = getBootPromises();
  if (promises.has(agentId)) return promises.get(agentId)!;

  const promise = doBootAgent(agentId).finally(() => promises.delete(agentId));
  promises.set(agentId, promise);
  return promise;
}

async function doBootAgent(agentId: string): Promise<void> {
  const config = getAgentById(agentId);
  if (!config) throw new Error(`Agent "${agentId}" not found in agents.json`);

  const proc = getAgentProcess(agentId, config);
  proc.booting = true;
  proc.error = null;

  try {
    let rpc: NdjsonRpc;

    if (config.relay) {
      // ── Relay agent: connect via Azure Relay WebSocket ──
      const connName = config.relayConnectionName || agentId;
      proc.cachedCwd = config.cwd || '/';
      console.log(`[ACP:${agentId}] Connecting via Azure Relay: ${connName}`);
      rpc = await createRelayNdjsonRpc(connName);

      // Treat relay disconnect as agent death
      rpc.onClose = (reason) => {
        console.log(`[ACP:${agentId}] Relay disconnected: ${reason}`);
        proc.rpc = null;
        proc.ready = false;
        proc.booting = false;
        proc.knownSessions.clear();
        for (const [key, sess] of getUserSessions()) {
          if (key.startsWith(`${agentId}:`)) {
            sess.phase = 'idle';
            sess.sessionId = null;
            if (sess.activeTurn && !sess.activeTurn.done) {
              sess.activeTurn.done = true;
              sess.activeTurn.phase = 'done';
              sess.activeTurn.error = `Relay disconnected: ${reason}`;
              sess.activeTurn.statusText = sess.activeTurn.error;
            }
          }
        }
      };
    } else {
      // ── Local agent: spawn child process ──
      const commandParts = (config.command || 'copilot.exe').trim().split(/\s+/);
      const command = commandParts[0];
      const commandExtraArgs = commandParts.slice(1);
      const args = [...commandExtraArgs, ...(config.args || ['--acp'])];
      if (config.yolo && !args.includes('--yolo')) args.push('--yolo');
      const cwd = config.cwd || process.cwd();
      proc.cachedCwd = cwd;

      console.log(`[ACP:${agentId}] Spawning ${command} ${args.join(' ')} (cwd: ${cwd})`);
      const cp = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd,
        env: process.env,
        windowsHide: true,
      });

      cp.stderr?.on('data', () => {});

      cp.on('exit', (code) => {
        console.log(`[ACP:${agentId}] Process exited (code ${code})`);
        proc.rpc = null;
        proc.ready = false;
        proc.booting = false;
        proc.knownSessions.clear();
        for (const [key, sess] of getUserSessions()) {
          if (key.startsWith(`${agentId}:`)) {
            sess.phase = 'idle';
            sess.sessionId = null;
            if (sess.activeTurn && !sess.activeTurn.done) {
              sess.activeTurn.done = true;
              sess.activeTurn.phase = 'done';
              sess.activeTurn.error = `ACP process exited (code ${code})`;
              sess.activeTurn.statusText = sess.activeTurn.error;
            }
          }
        }
      });

      rpc = createNdjsonRpc(cp);
    }

    proc.rpc = rpc;

    rpc.onRequest = (method, params, id) => {
      console.log(`[ACP:${agentId}] ← request: ${method} (id=${id})`);

      // noTools agents: deny all tool/permission requests so the agent responds quickly
      if (config.noTools) {
        if (method === 'session/request_permission') {
          rpc.respond(id, { outcome: { outcome: 'denied', message: 'Tools disabled for this agent' } });
        } else if (method === 'terminal/create' || method === 'fs/read_text_file' || method === 'fs/write_text_file') {
          rpc.respond(id, { error: 'Tools disabled for this agent' });
        } else {
          rpc.respond(id, {});
        }
        return;
      }

      if (method === 'session/request_permission') {
        rpc.respond(id, { outcome: { outcome: 'approved' } });
      } else if (method === 'terminal/create') {
        const result = handleTerminalCreate(params ?? {}, proc.cachedCwd);
        rpc.respond(id, result);
      } else if (method === 'terminal/output') {
        rpc.respond(id, handleTerminalOutput(params ?? {}));
      } else if (method === 'terminal/wait_for_exit') {
        handleTerminalWaitForExit(params ?? {}).then(r => rpc.respond(id, r));
      } else if (method === 'terminal/release') {
        rpc.respond(id, handleTerminalRelease(params ?? {}));
      } else if (method === 'terminal/kill') {
        rpc.respond(id, handleTerminalKill(params ?? {}));
      } else if (method === 'fs/read_text_file') {
        handleReadTextFile(params ?? {}).then(r => rpc.respond(id, r));
      } else if (method === 'fs/write_text_file') {
        handleWriteTextFile(params ?? {}).then(r => rpc.respond(id, r));
      } else {
        console.log(`[ACP:${agentId}] Unknown request: ${method}`);
        rpc.respond(id, {});
      }
    };

    // Notification counter for memory diagnostics
    let notifCount = 0;
    let lastNotifLog = Date.now();

    rpc.onNotification = (method, params) => {
      notifCount++;
      const now = Date.now();
      if (now - lastNotifLog >= 10_000) {
        console.log(`[ACP:${agentId}] notifications: ${notifCount} in last ${((now - lastNotifLog) / 1000).toFixed(0)}s (${method})`);
        notifCount = 0;
        lastNotifLog = now;
      }
      if (method !== 'session/update') {
        return;
      }
      const update = params?.update;
      const kind = update?.sessionUpdate;
      // Route notification to correct user session by sessionId
      const notifSessionId = params?.sessionId as string | undefined;

      // During session/load, capture replayed messages into the replay buffer
      if (notifSessionId) {
        const replayBuf = getReplayBuffers().get(notifSessionId);
        if (replayBuf) {
          if (kind === 'user_message_chunk' && update.content?.type === 'text') {
            // Append to last user entry or create new one
            const last = replayBuf.length > 0 ? replayBuf[replayBuf.length - 1] : null;
            if (last && last.role === 'user') {
              last.text += update.content.text;
            } else {
              replayBuf.push({ role: 'user', text: update.content.text });
            }
          } else if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
            const last = replayBuf.length > 0 ? replayBuf[replayBuf.length - 1] : null;
            if (last && last.role === 'agent') {
              last.text += update.content.text;
            } else {
              replayBuf.push({ role: 'agent', text: update.content.text });
            }
          }
          // Don't return — also let normal turn handling process if there's an active turn
        }
      }

      const turn = notifSessionId
        ? findUserSessionBySessionId(notifSessionId)?.activeTurn
        : undefined;
      if (!turn || turn.done) return;

      if (kind === 'agent_message_chunk' && update.content?.type === 'text') {
        turn.fullText += update.content.text;
        turn.phase = 'replying';
        turn.statusText = '';
        turn.events.push({ type: 'text_chunk', ts: Date.now(), text: update.content.text });
      } else if (kind === 'agent_thought_chunk' && update.content?.type === 'text') {
        turn.phase = 'thinking';
        turn.statusText = update.content.text || 'Thinking';
        turn.events.push({ type: 'thinking', ts: Date.now(), text: update.content.text });
      } else if (kind === 'tool_call' && update.status === 'pending') {
        turn.phase = 'tool_exec';
        const toolName = update.title || 'unknown';
        turn.statusText = toolName;
        turn.events.push({
          type: 'tool_start', ts: Date.now(), toolName,
          toolCallId: update.toolCallId,
          toolArgs: typeof update.rawInput === 'string' ? update.rawInput : JSON.stringify(update.rawInput ?? ''),
        });
      } else if (kind === 'tool_call_update' && update.status === 'completed') {
        turn.events.push({
          type: 'tool_complete', ts: Date.now(),
          toolCallId: update.toolCallId,
          toolName: update.toolCallId || 'unknown',
          toolResult: typeof update.rawOutput === 'string' ? update.rawOutput?.slice(0, 2000) :
            JSON.stringify(update.rawOutput ?? '').slice(0, 2000),
        });
      } else if (kind === 'agent_turn_start') {
        turn.phase = 'thinking';
        turn.statusText = 'Thinking';
        turn.events.push({ type: 'thinking', ts: Date.now() });
      }
    };

    console.log(`[ACP:${agentId}] Initializing...`);
    const initResult = await rpc.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    proc.supportsLoadSession = !!initResult?.agentCapabilities?.loadSession;
    console.log(`[ACP:${agentId}] loadSession capability: ${proc.supportsLoadSession}`);

    // No longer create a session at boot — sessions are created per-user on first send
    proc.ready = true;
    proc.booting = false;
    console.log(`[ACP:${agentId}] Ready. Awaiting user sessions.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ACP:${agentId}] Boot failed:`, msg);
    proc.error = msg;
    proc.booting = false;
    if (proc.rpc) {
      proc.rpc.destroy();
      proc.rpc = null;
    }
    throw err;
  }
}

/* ─────────────── Prompt Execution (Multi-User) ─────────────── */

// MCP servers blocked for non-admin (Microsoft) users
const ADMIN_ONLY_MCP = new Set(['teams']);

async function loadMcpServers(isAdmin: boolean): Promise<Record<string, unknown>[]> {
  try {
    const mcpConfigPath = path.join(os.homedir(), '.copilot', 'mcp-config.json');
    const mcpRaw = await fs.readFile(mcpConfigPath, 'utf-8');
    const mcpData = JSON.parse(mcpRaw);
    if (mcpData?.mcpServers && typeof mcpData.mcpServers === 'object') {
      const obj = mcpData.mcpServers as Record<string, Record<string, unknown>>;
      return Object.entries(obj)
        .filter(([name]) => isAdmin || !ADMIN_ONLY_MCP.has(name))
        .map(([name, cfg]) => ({
          name,
          command: cfg.command as string,
          args: (cfg.args as string[]) || [],
          env: (cfg.env as string[]) || [],
        }));
    }
  } catch { /* ignore */ }
  return [];
}

async function ensureUserSession(proc: AgentProcess, sess: UserSession, agentId: string, userId: string, isAdmin: boolean): Promise<void> {
  if (sess.sessionId) return;
  if (!proc.rpc) throw new Error('Agent process not ready');
  // noTools agents get no MCP servers to prevent tool usage and speed up responses
  const mcpServers = proc.config.noTools ? [] : await loadMcpServers(isAdmin);
  console.log(`[ACP:${agentId}] Creating session for user ${userId} (admin=${isAdmin}, mcps=${mcpServers.length}, noTools=${!!proc.config.noTools})...`);
  const result = await proc.rpc.send('session/new', { cwd: proc.cachedCwd, mcpServers });
  sess.sessionId = result.sessionId;
  proc.knownSessions.add(result.sessionId);
  console.log(`[ACP:${agentId}] Session ${result.sessionId} created for user ${userId}`);
}

function sendPrompt(proc: AgentProcess, sess: UserSession, agentId: string, prompt: string, isAdmin: boolean, userId: string, chatHistory?: { type: string; content: string; agentId?: string }[], chatId?: string): TurnState {
  const turnId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const turn: TurnState = {
    id: turnId,
    prompt,
    startedAt: Date.now(),
    fullText: '',
    done: false,
    phase: 'thinking',
    statusText: 'Thinking',
    events: [],
  };

  sess.activeTurn = turn;
  sess.phase = 'busy';
  sess.turnCount++;

  proc.rpc!
    .send('session/prompt', {
      sessionId: sess.sessionId,
      prompt: [{ type: 'text', text: prompt }],
    })
    .then((result: Record<string, unknown> | undefined) => {
      const stopReason = result?.stopReason ?? 'unknown';
      const elapsed = ((Date.now() - turn.startedAt) / 1000).toFixed(1);
      console.log(`[ACP:${agentId}] prompt done: reason=${stopReason}, ${elapsed}s, ${turn.fullText.length} chars`);
      if (!turn.done) {
        turn.done = true;
        turn.phase = 'done';
        turn.statusText = '';
        sess.phase = 'idle';
      }
      // Don't clear events here — let frontend poll one last time with full events.
      // Events are cleared in turn-clear or auto-release.
      turn.prompt = '';
      // Auto-release turn reference after 30s so GC can reclaim memory
      setTimeout(() => {
        if (sess.activeTurn === turn) {
          sess.activeTurn = null;
        }
      }, 30_000);
    })
    .catch(async (err: Error) => {
      // If session/prompt fails, the session may be truly invalid — try to recover
      const errMsg = err.message || '';
      console.log(`[ACP:${agentId}] prompt failed: ${errMsg}, attempting session recovery...`);
      try {
        const mcpServers = await loadMcpServers(isAdmin);
        const session = await proc.rpc!.send('session/new', { cwd: proc.cachedCwd, mcpServers });
        sess.sessionId = session.sessionId;
        proc.knownSessions.add(session.sessionId);
        if (chatId) pushChatSession(sess, chatId, session.sessionId);
        console.log(`[ACP:${agentId}] Recovered with new session ${session.sessionId} for user ${userId}`);

        // Persist the new sessionId to SQLite so chat history references stay current
        if (chatId) {
          updateChatAgentSession(userId, chatId, agentId, session.sessionId).catch(() => { /* ignore */ });
        }

        // Build context-aware prompt if chat history is available
        let retryText = prompt;
        if (chatHistory && chatHistory.length > 0) {
          const recent = chatHistory.slice(-20);
          const contextLines = recent.map(m => {
            const role = m.type === 'user' ? 'User' : (m.agentId || 'Assistant');
            return `${role}: ${m.content.slice(0, 500)}`;
          }).join('\n');
          retryText = `[Previous conversation context — the session was lost, please continue naturally based on this history]\n${contextLines}\n\n[Current message]\n${prompt}`;
          console.log(`[ACP:${agentId}] Injected ${recent.length} messages as context for recovery`);
        }

        // Retry the prompt on the new session
        turn.phase = 'thinking';
        turn.statusText = 'Reconnected — retrying';
        turn.events.push({ type: 'thinking', ts: Date.now(), text: '(Session recovered, retrying...)' });

        const retryResult = await proc.rpc!.send('session/prompt', {
          sessionId: sess.sessionId,
          prompt: [{ type: 'text', text: retryText }],
        });
        const stopReason = retryResult?.stopReason ?? 'unknown';
        const elapsed = ((Date.now() - turn.startedAt) / 1000).toFixed(1);
        console.log(`[ACP:${agentId}] retry prompt done: reason=${stopReason}, ${elapsed}s`);
        if (!turn.done) {
          turn.done = true;
          turn.phase = 'done';
          turn.statusText = '';
          sess.phase = 'idle';
        }
        turn.prompt = '';
        setTimeout(() => { if (sess.activeTurn === turn) sess.activeTurn = null; }, 30_000);
      } catch (retryErr) {
        // Recovery also failed — report original error
        if (!turn.done) {
          turn.done = true;
          turn.phase = 'done';
          turn.error = errMsg || (retryErr instanceof Error ? retryErr.message : String(retryErr));
          turn.statusText = turn.error;
          sess.phase = 'idle';
        }
        turn.prompt = '';
        setTimeout(() => { if (sess.activeTurn === turn) sess.activeTurn = null; }, 30_000);
      }
    });

  return turn;
}

function serializeTurn(turn: TurnState | null, sinceEvent?: number) {
  if (!turn) return null;
  const events = typeof sinceEvent === 'number' ? turn.events.slice(sinceEvent) : turn.events;
  return {
    id: turn.id,
    prompt: turn.prompt,
    startedAt: turn.startedAt,
    fullText: turn.fullText.trim(),
    done: turn.done,
    phase: turn.phase,
    statusText: turn.statusText,
    error: turn.error,
    events,
    totalEvents: turn.events.length,
  };
}

/* ─────────── Chat Recovery: compare ACP replay with SQLite ─────────── */

/**
 * After session/load replays the conversation, compare replayed messages
 * with what's stored in SQLite. Returns:
 * - recoveredMessages: agent messages that were in the ACP session but missing from SQLite
 * - pendingUserMessage: if the last stored message is a user message with no agent reply
 */
async function compareAndRecover(
  userId: string,
  chatId: string | undefined,
  agentId: string,
  replayMessages: { role: 'user' | 'agent'; text: string }[],
): Promise<{
  recoveredMessages?: { type: 'agent'; content: string; agentId: string; ts: number }[];
  pendingUserMessage?: string;
}> {
  if (!chatId) return {};

  const chat = await getChat(userId, chatId);
  if (!chat || chat.messages.length === 0) return {};

  // Only check the last user message in SQLite
  const lastUserMsg = [...chat.messages].reverse().find(m => m.type === 'user');
  if (!lastUserMsg) return {};

  const lastStoredMsg = chat.messages[chat.messages.length - 1];
  const lastStoredIsUser = lastStoredMsg.type === 'user';

  // If the last stored message is already an agent reply, nothing to recover
  if (!lastStoredIsUser) return {};

  // Last stored message is a user question with no agent answer.
  // Find the last occurrence of that user message in the replay,
  // then check if there's an agent reply AFTER it.
  const userText = lastUserMsg.content;
  let lastUserIdx = -1;
  for (let i = replayMessages.length - 1; i >= 0; i--) {
    if (replayMessages[i].role === 'user' && replayMessages[i].text === userText) {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx >= 0) {
    // Look for agent replies after this user message in the replay
    const agentAfter = replayMessages.slice(lastUserIdx + 1).filter(m => m.role === 'agent' && m.text);
    if (agentAfter.length > 0) {
      // Take the last agent reply as the recovered answer
      const replyText = agentAfter[agentAfter.length - 1].text;
      const ts = Date.now();
      const recovered = [{ type: 'agent' as const, content: replyText, agentId, ts }];
      chat.messages.push({
        id: `recovered-${ts}`,
        type: 'agent',
        content: replyText,
        agentId,
        ts,
      });
      chat.ts = ts;
      await saveChat(userId, chat);
      console.log(`[ACP:recovery] Recovered agent reply for last user message in chat ${chatId}`);
      return { recoveredMessages: recovered };
    }
  }

  // ACP has no reply after the user's last message → re-send it
  return { pendingUserMessage: userText };
}

/* ──────────────────── API Handler ──────────────────── */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action as string | undefined;
    const agentId = body?.agentId as string | undefined;

    if (!action) {
      return NextResponse.json({ ok: false, error: 'missing_action' }, { status: 400 });
    }

    // ─── Diagnostic endpoint ───
    if (action === 'diag') {
      const mem = process.memoryUsage();
      const toMB = (b: number) => (b / 1024 / 1024).toFixed(1);
      return NextResponse.json({
        ok: true,
        memory: {
          rss: `${toMB(mem.rss)}MB`,
          heapTotal: `${toMB(mem.heapTotal)}MB`,
          heapUsed: `${toMB(mem.heapUsed)}MB`,
          external: `${toMB(mem.external)}MB`,
          arrayBuffers: `${toMB(mem.arrayBuffers)}MB`,
        },
        sessions: getUserSessions().size,
        agents: getAgentProcesses().size,
        replayBuffers: getReplayBuffers().size,
        terminals: getTerminals().size,
      });
    }

    // ─── Config endpoints (no agentId required) ───

    if (action === 'list-agents') {
      const allAgents = configStore.getAllAgents();
      const token = await getAuthToken(req);
      const userEmail = getUserEmail(token);
      // All authenticated users can see all agents; include canModify flag and hide sensitive fields for non-privileged users
      const agents = allAgents.map(a => {
        const userCanModify = canModify(token, a.owner);
        const base = { id: a.id, name: a.name, owner: a.owner, canModify: userCanModify, relay: a.relay, noTools: a.noTools };
        if (userCanModify) {
          return { ...base, command: a.command, args: a.args, cwd: a.cwd, yolo: a.yolo, relayConnectionName: a.relayConnectionName };
        }
        return base;
      });
      return NextResponse.json({ ok: true, agents });
    }

    if (action === 'get-agent-config') {
      if (!agentId) return NextResponse.json({ ok: false, error: 'missing_agentId' }, { status: 400 });
      const agent = getAgentById(agentId);
      if (!agent) return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
      return NextResponse.json({ ok: true, agent });
    }

    if (action === 'get-sessions') {
      // Return current session IDs for all agents for this user
      const userId = String(body?.userId || 'anonymous');
      const allAgents = readAgentsConfig();
      const sessionMap: Record<string, string | null> = {};
      for (const agent of allAgents) {
        const s = getUserSessions().get(userSessionKey(agent.id, userId));
        sessionMap[agent.id] = s?.sessionId ?? null;
      }
      return NextResponse.json({ ok: true, sessions: sessionMap });
    }

    // ─── Agent config mutation actions (admin or owner) ───

    if (action === 'update-agent-config') {
      if (!agentId) return NextResponse.json({ ok: false, error: 'missing_agentId' }, { status: 400 });
      const token = await getAuthToken(req);
      const agent = configStore.getAgentById(agentId);
      if (!agent) return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
      if (!canModify(token, agent.owner)) {
        return NextResponse.json({ ok: false, error: 'permission_denied' }, { status: 403 });
      }

      const updates = body?.updates as Partial<AgentConfig> | undefined;
      if (!updates) return NextResponse.json({ ok: false, error: 'missing_updates' }, { status: 400 });

      configStore.updateAgent(agentId, {
        name: updates.name,
        command: updates.command,
        args: updates.args,
        cwd: updates.cwd,
        yolo: updates.yolo,
      });

      // Restart if running
      let restarted = false;
      const procs = getAgentProcesses();
      const existing = procs.get(agentId);
      if (existing?.ready) {
        if (existing.rpc) existing.rpc.destroy();
        procs.delete(agentId);
        for (const key of [...getUserSessions().keys()]) {
          if (key.startsWith(`${agentId}:`)) getUserSessions().delete(key);
        }
        bootAgent(agentId).catch(err => console.error(`[ACP:${agentId}] Restart failed:`, err));
        restarted = true;
      }

      const updated = configStore.getAgentById(agentId);
      return NextResponse.json({ ok: true, agent: updated, restarted });
    }

    if (action === 'create-agent') {
      const token = await getAuthToken(req);
      const ownerEmail = getUserEmail(token);
      if (!ownerEmail) {
        return NextResponse.json({ ok: false, error: 'email_required_for_ownership' }, { status: 400 });
      }

      const newAgent = body?.agent as Partial<AgentConfig> | undefined;
      if (!newAgent?.id) return NextResponse.json({ ok: false, error: 'missing_agent_id' }, { status: 400 });

      const existingAgent = configStore.getAgentById(newAgent.id);
      if (existingAgent) {
        return NextResponse.json({ ok: false, error: 'agent_id_already_exists' }, { status: 409 });
      }

      const entry = configStore.createAgent({
        id: newAgent.id,
        name: newAgent.name || newAgent.id,
        command: newAgent.command || 'copilot.exe',
        args: newAgent.args || ['--acp'],
        cwd: newAgent.cwd || '',
        yolo: newAgent.yolo ?? true,
        relay: newAgent.relay,
        relayConnectionName: newAgent.relayConnectionName || (newAgent.relay ? newAgent.id : ''),
        owner: ownerEmail,
      });

      return NextResponse.json({ ok: true, agent: entry });
    }

    if (action === 'delete-agent') {
      if (!agentId) return NextResponse.json({ ok: false, error: 'missing_agentId' }, { status: 400 });
      const token = await getAuthToken(req);
      const agent = configStore.getAgentById(agentId);
      if (!agent) return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
      if (!canModify(token, agent.owner)) {
        return NextResponse.json({ ok: false, error: 'permission_denied' }, { status: 403 });
      }

      // Stop if running
      const procs2 = getAgentProcesses();
      const existing2 = procs2.get(agentId);
      if (existing2?.rpc) existing2.rpc.destroy();
      procs2.delete(agentId);
      for (const key of [...getUserSessions().keys()]) {
        if (key.startsWith(`${agentId}:`)) getUserSessions().delete(key);
      }

      configStore.deleteAgent(agentId);
      return NextResponse.json({ ok: true });
    }

    // ─── Agent runtime actions (require agentId + userId) ───

    if (!agentId) {
      return NextResponse.json({ ok: false, error: 'missing_agentId' }, { status: 400 });
    }

    const config = getAgentById(agentId);
    if (!config) {
      return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
    }

    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
    const userId = String(token?.email || token?.name || token?.sub || 'anonymous');
    const isAdmin = isAdminToken(token);
    const proc = getAgentProcess(agentId, config);
    const sess = getUserSession(agentId, userId);

    if (action === 'status') {
      return NextResponse.json({
        ok: true,
        agentId,
        phase: sess.sessionId ? sess.phase : (proc.booting ? 'booting' : proc.ready ? 'idle' : 'idle'),
        ready: proc.ready,
        booting: proc.booting,
        sessionId: sess.sessionId,
        activeTurn: serializeTurn(sess.activeTurn),
        error: proc.error,
      });
    }

    if (action === 'start') {
      if (!proc.ready && !proc.booting) {
        bootAgent(agentId).catch(err => console.error(`[ACP:${agentId}] Boot failed:`, err));
      }
      return NextResponse.json({
        ok: true,
        started: true,
        agentId,
        phase: proc.booting ? 'booting' : (proc.ready ? 'idle' : 'idle'),
        ready: proc.ready,
        booting: proc.booting,
      });
    }

    if (action === 'send') {
      const text = String(body?.text ?? '');
      if (!text) return NextResponse.json({ ok: false, error: 'missing_text' }, { status: 400 });
      const chatHistory = Array.isArray(body?.chatHistory) ? body.chatHistory as { type: string; content: string; agentId?: string }[] : undefined;
      const chatId = body?.chatId as string | undefined;

      if (!proc.ready) {
        if (!proc.booting) {
          await bootAgent(agentId);
        } else {
          const promises = getBootPromises();
          const p = promises.get(agentId);
          if (p) await p;
        }
        if (!proc.ready) {
          return NextResponse.json({ ok: false, error: proc.error || 'ACP boot failed' }, { status: 503 });
        }
      }

      // Switch to the correct session for this chat (if known)
      if (chatId) {
        const chatSessionId = getChatSession(sess, chatId);
        if (chatSessionId && chatSessionId !== sess.sessionId) {
          sess.sessionId = chatSessionId;
          sess.activeTurn = null;
          sess.phase = 'idle';
        }
      }

      // Ensure this user has a session on the agent
      await ensureUserSession(proc, sess, agentId, userId, isAdmin);

      // Store in chatSessions list and persist to SQLite
      if (chatId && sess.sessionId) {
        pushChatSession(sess, chatId, sess.sessionId);
        updateChatAgentSession(userId, chatId, agentId, sess.sessionId).catch(() => { /* ignore */ });
      }

      console.log(`[ACP:${agentId}] send: chat=${chatId}, session=${sess.sessionId}, sessions=${JSON.stringify(chatId ? sess.chatSessions.get(chatId) : null)}`);

      if (sess.activeTurn && !sess.activeTurn.done) {
        return NextResponse.json({ ok: false, error: 'turn_in_progress' }, { status: 409 });
      }

      const turn = sendPrompt(proc, sess, agentId, text, isAdmin, userId, chatHistory, chatId);
      return NextResponse.json({ ok: true, phase: sess.phase, turn: serializeTurn(turn) });
    }

    if (action === 'poll') {
      return NextResponse.json({
        ok: true,
        phase: sess.sessionId ? sess.phase : (proc.booting ? 'booting' : (proc.ready ? 'idle' : 'idle')),
        ready: proc.ready,
        booting: proc.booting,
        sessionId: sess.sessionId,
        activeTurn: serializeTurn(sess.activeTurn),
      });
    }

    if (action === 'turn-clear') {
      if (sess.activeTurn) {
        sess.activeTurn.events = [];
        sess.activeTurn = null;
      }
      return NextResponse.json({ ok: true });
    }

    if (action === 'interrupt') {
      if (sess.activeTurn && !sess.activeTurn.done && proc.rpc && sess.sessionId) {
        try {
          await proc.rpc.send('session/cancel', { sessionId: sess.sessionId }, 5000);
        } catch {
          try {
            proc.rpc.writeRaw(
              JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sess.sessionId } })
            );
          } catch { /* ignore */ }
        }
        sess.activeTurn.done = true;
        sess.activeTurn.phase = 'done';
        sess.activeTurn.statusText = 'Interrupted';
        sess.phase = 'idle';
      }
      return NextResponse.json({ ok: true });
    }

    if (action === 'reset') {
      // Reset only this user's session, not the shared process
      // Note: ACP has no session/close method — sessions persist on the agent side
      getUserSessions().delete(userSessionKey(agentId, userId));
      return NextResponse.json({ ok: true });
    }

    if (action === 'new-session') {
      const chatId = body?.chatId as string | undefined;
      if (!proc.ready || !proc.rpc) {
        return NextResponse.json({ ok: true, skipped: true });
      }
      try {
        // Note: ACP has no session/close — old session persists on the agent for future session/load
        const mcpServers = await loadMcpServers(isAdmin);
        const session = await proc.rpc.send('session/new', { cwd: proc.cachedCwd, mcpServers });
        sess.sessionId = session.sessionId;
        proc.knownSessions.add(session.sessionId);
        if (chatId) pushChatSession(sess, chatId, session.sessionId);
        sess.activeTurn = null;
        sess.phase = 'idle';
        // Persist session ID to SQLite
        if (chatId) {
          updateChatAgentSession(userId, chatId, agentId, session.sessionId).catch(() => { /* ignore */ });
        }
        console.log(`[ACP:${agentId}] New session ${session.sessionId} for user ${userId}${chatId ? ` (chat ${chatId})` : ''}`);
        return NextResponse.json({ ok: true, sessionId: session.sessionId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    if (action === 'resume-session') {
      // Use session/load to restore a previously saved session from disk.
      // If session/load fails (e.g. session expired or not on disk), fall back to session/new.
      // After successful load, compare replayed messages with SQLite to recover missing answers.
      const savedSessionId = body?.sessionId as string | undefined;
      const chatId = body?.chatId as string | undefined;
      if (!savedSessionId) {
        return NextResponse.json({ ok: false, error: 'missing_sessionId' }, { status: 400 });
      }
      if (!proc.ready || !proc.rpc) {
        // Agent not running — boot it first
        if (!proc.booting) {
          try {
            await bootAgent(agentId);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return NextResponse.json({ ok: false, error: msg }, { status: 503 });
          }
        } else {
          const p = getBootPromises().get(agentId);
          if (p) await p;
        }
      }
      if (!proc.ready || !proc.rpc) {
        return NextResponse.json({ ok: false, error: 'Agent not ready after boot' }, { status: 503 });
      }
      // Detach current session (ACP has no session/close — sessions persist for future session/load)
      // If this session is known to be active in the agent, just switch to it
      if (sess.sessionId === savedSessionId || proc.knownSessions.has(savedSessionId)) {
        sess.sessionId = savedSessionId;
        if (chatId) pushChatSession(sess, chatId, savedSessionId);
        sess.activeTurn = null;
        sess.phase = 'idle';
        console.log(`[ACP:${agentId}] Session ${savedSessionId} already known for user ${userId}, switching without load`);
        return NextResponse.json({ ok: true, sessionId: savedSessionId, loaded: true });
      }
      // Try session/load if the agent supports it
      if (proc.supportsLoadSession) {
        // Set up replay buffer to capture messages during session/load
        const replayBuffers = getReplayBuffers();
        replayBuffers.set(savedSessionId, []);
        try {
          const mcpServers = await loadMcpServers(isAdmin);
          await proc.rpc!.send('session/load', { sessionId: savedSessionId, cwd: proc.cachedCwd, mcpServers });
          sess.sessionId = savedSessionId;
          if (chatId) pushChatSession(sess, chatId, savedSessionId);
          sess.activeTurn = null;
          sess.phase = 'idle';
          proc.knownSessions.add(savedSessionId);

          // Extract replay buffer and compare with SQLite
          const replayMessages = replayBuffers.get(savedSessionId) || [];
          replayBuffers.delete(savedSessionId);
          console.log(`[ACP:${agentId}] Loaded session ${savedSessionId} for user ${userId}, replayed ${replayMessages.length} message chunks`);

          // Compare with stored chat to find recovered messages
          const recovery = await compareAndRecover(userId, chatId, agentId, replayMessages);
          return NextResponse.json({ ok: true, sessionId: savedSessionId, loaded: true, ...recovery });
        } catch (loadErr: any) {
          replayBuffers.delete(savedSessionId);
          // If session is already loaded, just reuse it
          const errStr = loadErr instanceof Error ? loadErr.message : String(loadErr);
          let code = loadErr?.data?.code ?? loadErr?.code;
          if (!code) { try { code = JSON.parse(errStr)?.code; } catch { /* ignore */ } }
          const alreadyLoaded = code === -32602 || /already loaded/i.test(errStr);
          if (alreadyLoaded) {
            sess.sessionId = savedSessionId;
            if (chatId) pushChatSession(sess, chatId, savedSessionId);
            sess.activeTurn = null;
            sess.phase = 'idle';
            proc.knownSessions.add(savedSessionId);
            console.log(`[ACP:${agentId}] Session ${savedSessionId} already loaded for user ${userId}, reusing`);
            return NextResponse.json({ ok: true, sessionId: savedSessionId, loaded: true });
          }
          console.log(`[ACP:${agentId}] session/load failed for ${savedSessionId}: ${errStr}, falling back to session/new`);
        }
      } else {
        console.log(`[ACP:${agentId}] Agent does not support loadSession, falling back to session/new`);
      }
      // Fall back to creating a new session — the frontend will inject chat history on first turn
      try {
        const mcpServers = await loadMcpServers(isAdmin);
        const session = await proc.rpc!.send('session/new', { cwd: proc.cachedCwd, mcpServers });
        sess.sessionId = session.sessionId;
        if (chatId) pushChatSession(sess, chatId, session.sessionId);
        sess.activeTurn = null;
        sess.phase = 'idle';
        proc.knownSessions.add(session.sessionId);
        // Update SQLite with the new sessionId
        if (chatId) {
          updateChatAgentSession(userId, chatId, agentId, session.sessionId).catch(() => { /* ignore */ });
        }
        // Check if last message is an unanswered user question
        let pendingUserMessage: string | undefined;
        if (chatId) {
          const chat = await getChat(userId, chatId);
          if (chat && chat.messages.length > 0) {
            const lastMsg = chat.messages[chat.messages.length - 1];
            if (lastMsg.type === 'user') {
              pendingUserMessage = lastMsg.content;
            }
          }
        }
        console.log(`[ACP:${agentId}] Fallback new session ${session.sessionId} for user ${userId}`);
        return NextResponse.json({ ok: true, sessionId: session.sessionId, loaded: false, pendingUserMessage });
      } catch (newErr) {
        const msg = newErr instanceof Error ? newErr.message : String(newErr);
        return NextResponse.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: false, error: 'unsupported_action' }, { status: 400 });
  } catch (error) {
    console.error(`[ACP] POST error:`, error instanceof Error ? error.message : String(error));
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
