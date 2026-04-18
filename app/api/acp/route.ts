import { NextRequest, NextResponse } from 'next/server';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { getToken } from 'next-auth/jwt';
import { updateChatAgentSession } from '@/lib/chatStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ACP (Agent Client Protocol) backend for multiple ACP agents.
 *
 * Agents are configured in agents.json at the project root.
 * Each agent is a persistent child process communicating via NDJSON-RPC over stdio.
 */

/* ─────────────── Admin check helper ─────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isAdminToken(token: any): boolean {
  if (!token) return false;
  // Credentials login sets role=admin in the JWT callback
  if (token.role === 'admin') return true;
  // Credentials login user has sub='admin' (the id from the provider)
  if (token.sub === 'admin') return true;
  // Fallback: check ADMIN_EMAILS env var (for Azure AD users)
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e: string) => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) return false;
  const email = ((token.email as string) || '').toLowerCase();
  return adminEmails.includes(email);
}

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
};

/* ─────────── Minimal NDJSON-RPC over raw Node streams ─────────── */

type PendingRequest = {
  resolve: (result: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  reject: (err: Error) => void;
};

type NdjsonRpc = {
  process: ChildProcess;
  send: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  respond: (id: number | string, result: Record<string, unknown>) => void;
  onNotification: ((method: string, params: any) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  onRequest: ((method: string, params: any, id: number | string) => void) | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  destroy: () => void;
};

function createNdjsonRpc(cp: ChildProcess): NdjsonRpc {
  let nextId = 0;
  const pending = new Map<number, PendingRequest>();
  let buf = '';

  const rpc: NdjsonRpc = {
    process: cp,
    onNotification: null,
    onRequest: null,

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

  cp.stdout?.on('data', (chunk: Buffer) => { terminal.output += chunk.toString(); });
  cp.stderr?.on('data', (chunk: Buffer) => { terminal.output += chunk.toString(); });
  cp.on('exit', (code, signal) => {
    terminal.exitCode = code;
    terminal.signal = signal;
    terminal.done = true;
    for (const w of terminal.waiters) w({ exitCode: code, signal });
    terminal.waiters = [];
    console.log(`[ACP-TERM] ${id} exited (code=${code})`);
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

/* ─────────────── agents.json Config ─────────────── */

const AGENTS_CONFIG_PATH = path.join(process.cwd(), 'agents.json');

async function readAgentsConfig(): Promise<AgentConfig[]> {
  try {
    const raw = await fs.readFile(AGENTS_CONFIG_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return (data.agents || []) as AgentConfig[];
  } catch {
    return [];
  }
}

async function writeAgentsConfig(agents: AgentConfig[]): Promise<void> {
  await fs.writeFile(AGENTS_CONFIG_PATH, JSON.stringify({ agents }, null, 2), 'utf-8');
}

async function getAgentById(agentId: string): Promise<AgentConfig | null> {
  const agents = await readAgentsConfig();
  return agents.find(a => a.id === agentId) ?? null;
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
  activeTurn: TurnState | null;
  phase: 'idle' | 'busy' | 'booting';
  turnCount: number;
  lastActive: number;
};

const globalStore = globalThis as typeof globalThis & {
  __acpAgents?: Map<string, AgentProcess>;
  __acpUserSessions?: Map<string, UserSession>;
  __acpBootPromises?: Map<string, Promise<void>>;
};

function getAgentProcesses(): Map<string, AgentProcess> {
  if (!globalStore.__acpAgents) globalStore.__acpAgents = new Map();
  return globalStore.__acpAgents;
}

function getUserSessions(): Map<string, UserSession> {
  if (!globalStore.__acpUserSessions) globalStore.__acpUserSessions = new Map();
  return globalStore.__acpUserSessions;
}

function getBootPromises(): Map<string, Promise<void>> {
  if (!globalStore.__acpBootPromises) globalStore.__acpBootPromises = new Map();
  return globalStore.__acpBootPromises;
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
      activeTurn: null,
      phase: 'idle',
      turnCount: 0,
      lastActive: Date.now(),
    };
    sessions.set(key, sess);
  }
  sess.lastActive = Date.now();
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
  const config = await getAgentById(agentId);
  if (!config) throw new Error(`Agent "${agentId}" not found in agents.json`);

  const proc = getAgentProcess(agentId, config);
  proc.booting = true;
  proc.error = null;

  try {
    // Split command string so "agency copilot" becomes spawn("agency", ["copilot", ...args])
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
      // Mark all user sessions for this agent as done
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

    const rpc = createNdjsonRpc(cp);
    proc.rpc = rpc;

    rpc.onRequest = (method, params, id) => {
      console.log(`[ACP:${agentId}] ← request: ${method} (id=${id})`);
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

    rpc.onNotification = (method, params) => {
      console.log(`[ACP:${agentId}] NOTIF method=${method}`, JSON.stringify(params).slice(0, 300));
      if (method !== 'session/update') return;
      const update = params?.update;
      // Route notification to correct user session by sessionId
      const notifSessionId = params?.sessionId as string | undefined;
      const turn = notifSessionId
        ? findUserSessionBySessionId(notifSessionId)?.activeTurn
        : undefined;
      if (!turn || turn.done) return;

      const kind = update?.sessionUpdate;
      console.log(`[ACP:${agentId}] notification: ${kind}`, JSON.stringify(update).slice(0, 200));
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
  const mcpServers = await loadMcpServers(isAdmin);
  console.log(`[ACP:${agentId}] Creating session for user ${userId} (admin=${isAdmin}, mcps=${mcpServers.length})...`);
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
      } catch (retryErr) {
        // Recovery also failed — report original error
        if (!turn.done) {
          turn.done = true;
          turn.phase = 'done';
          turn.error = errMsg || (retryErr instanceof Error ? retryErr.message : String(retryErr));
          turn.statusText = turn.error;
          sess.phase = 'idle';
        }
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

/* ──────────────────── API Handler ──────────────────── */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action as string | undefined;
    const agentId = body?.agentId as string | undefined;

    if (!action) {
      return NextResponse.json({ ok: false, error: 'missing_action' }, { status: 400 });
    }

    // ─── Config endpoints (no agentId required) ───

    if (action === 'list-agents') {
      const allAgents = await readAgentsConfig();
      const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
      const agents = isAdminToken(token) ? allAgents : allAgents.filter(a => a.id === 'copilot');
      return NextResponse.json({ ok: true, agents });
    }

    if (action === 'get-agent-config') {
      if (!agentId) return NextResponse.json({ ok: false, error: 'missing_agentId' }, { status: 400 });
      const agent = await getAgentById(agentId);
      if (!agent) return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
      return NextResponse.json({ ok: true, agent });
    }

    if (action === 'get-sessions') {
      // Return current session IDs for all agents for this user
      const userId = String(body?.userId || 'anonymous');
      const allAgents = await readAgentsConfig();
      const sessionMap: Record<string, string | null> = {};
      for (const agent of allAgents) {
        const s = getUserSessions().get(userSessionKey(agent.id, userId));
        sessionMap[agent.id] = s?.sessionId ?? null;
      }
      return NextResponse.json({ ok: true, sessions: sessionMap });
    }

    // ─── Admin-only actions ───
    const ADMIN_ACTIONS = ['update-agent-config', 'create-agent', 'delete-agent'];
    if (ADMIN_ACTIONS.includes(action)) {
      const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
      if (!isAdminToken(token)) {
        return NextResponse.json({ ok: false, error: 'admin_only' }, { status: 403 });
      }
    }

    if (action === 'update-agent-config') {
      if (!agentId) return NextResponse.json({ ok: false, error: 'missing_agentId' }, { status: 400 });
      const updates = body?.updates as Partial<AgentConfig> | undefined;
      if (!updates) return NextResponse.json({ ok: false, error: 'missing_updates' }, { status: 400 });

      const agents = await readAgentsConfig();
      const idx = agents.findIndex(a => a.id === agentId);
      if (idx < 0) return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });

      if (updates.name !== undefined) agents[idx].name = updates.name;
      if (updates.command !== undefined) agents[idx].command = updates.command;
      if (updates.args !== undefined) agents[idx].args = updates.args;
      if (updates.cwd !== undefined) agents[idx].cwd = updates.cwd;
      if (updates.yolo !== undefined) agents[idx].yolo = updates.yolo;

      await writeAgentsConfig(agents);

      // Restart if running
      let restarted = false;
      const procs = getAgentProcesses();
      const existing = procs.get(agentId);
      if (existing?.ready) {
        if (existing.rpc) existing.rpc.destroy();
        procs.delete(agentId);
        // Clean up all user sessions for this agent
        for (const key of [...getUserSessions().keys()]) {
          if (key.startsWith(`${agentId}:`)) getUserSessions().delete(key);
        }
        bootAgent(agentId).catch(err => console.error(`[ACP:${agentId}] Restart failed:`, err));
        restarted = true;
      }

      return NextResponse.json({ ok: true, agent: agents[idx], restarted });
    }

    if (action === 'create-agent') {
      const newAgent = body?.agent as Partial<AgentConfig> | undefined;
      if (!newAgent?.id) return NextResponse.json({ ok: false, error: 'missing_agent_id' }, { status: 400 });

      const agents = await readAgentsConfig();
      if (agents.some(a => a.id === newAgent.id)) {
        return NextResponse.json({ ok: false, error: 'agent_id_already_exists' }, { status: 409 });
      }

      const entry: AgentConfig = {
        id: newAgent.id,
        name: newAgent.name || newAgent.id,
        command: newAgent.command || 'copilot.exe',
        args: newAgent.args || ['--acp'],
        cwd: newAgent.cwd || '',
        yolo: newAgent.yolo ?? true,
      };

      agents.push(entry);
      await writeAgentsConfig(agents);
      return NextResponse.json({ ok: true, agent: entry });
    }

    if (action === 'delete-agent') {
      if (!agentId) return NextResponse.json({ ok: false, error: 'missing_agentId' }, { status: 400 });
      const agents = await readAgentsConfig();
      const filtered = agents.filter(a => a.id !== agentId);
      if (filtered.length === agents.length) {
        return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
      }

      // Stop if running
      const procs2 = getAgentProcesses();
      const existing2 = procs2.get(agentId);
      if (existing2?.rpc) existing2.rpc.destroy();
      procs2.delete(agentId);
      // Clean up all user sessions for this agent
      for (const key of [...getUserSessions().keys()]) {
        if (key.startsWith(`${agentId}:`)) getUserSessions().delete(key);
      }

      await writeAgentsConfig(filtered);
      return NextResponse.json({ ok: true });
    }

    // ─── Agent runtime actions (require agentId + userId) ───

    if (!agentId) {
      return NextResponse.json({ ok: false, error: 'missing_agentId' }, { status: 400 });
    }

    const config = await getAgentById(agentId);
    if (!config) {
      return NextResponse.json({ ok: false, error: 'agent_not_found' }, { status: 404 });
    }

    const userId = String(body?.userId || 'anonymous');
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET, cookieName: 'next-auth.session-token' });
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

      // Ensure this user has a session on the agent
      await ensureUserSession(proc, sess, agentId, userId, isAdmin);

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
      sess.activeTurn = null;
      return NextResponse.json({ ok: true });
    }

    if (action === 'interrupt') {
      if (sess.activeTurn && !sess.activeTurn.done && proc.rpc && sess.sessionId) {
        try {
          await proc.rpc.send('session/cancel', { sessionId: sess.sessionId }, 5000);
        } catch {
          try {
            proc.rpc.process.stdin!.write(
              JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sess.sessionId } }) + '\n'
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
      if (!proc.ready || !proc.rpc) {
        return NextResponse.json({ ok: true, skipped: true });
      }
      try {
        // Note: ACP has no session/close — old session persists on the agent for future session/load
        const mcpServers = await loadMcpServers(isAdmin);
        const session = await proc.rpc.send('session/new', { cwd: proc.cachedCwd, mcpServers });
        sess.sessionId = session.sessionId;
        proc.knownSessions.add(session.sessionId);
        sess.activeTurn = null;
        sess.phase = 'idle';
        console.log(`[ACP:${agentId}] New session ${session.sessionId} for user ${userId}`);
        return NextResponse.json({ ok: true, sessionId: session.sessionId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    if (action === 'resume-session') {
      // Use session/load to restore a previously saved session from disk.
      // If session/load fails (e.g. session expired or not on disk), fall back to session/new.
      const savedSessionId = body?.sessionId as string | undefined;
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
        sess.activeTurn = null;
        sess.phase = 'idle';
        console.log(`[ACP:${agentId}] Session ${savedSessionId} already known for user ${userId}, switching without load`);
        return NextResponse.json({ ok: true, sessionId: savedSessionId, loaded: true });
      }
      // Try session/load if the agent supports it
      if (proc.supportsLoadSession) {
        try {
          const mcpServers = await loadMcpServers(isAdmin);
          await proc.rpc!.send('session/load', { sessionId: savedSessionId, cwd: proc.cachedCwd, mcpServers });
          sess.sessionId = savedSessionId;
          sess.activeTurn = null;
          sess.phase = 'idle';
          proc.knownSessions.add(savedSessionId);
          console.log(`[ACP:${agentId}] Loaded session ${savedSessionId} for user ${userId}`);
          return NextResponse.json({ ok: true, sessionId: savedSessionId, loaded: true });
        } catch (loadErr: any) {
          // If session is already loaded, just reuse it
          const errStr = loadErr instanceof Error ? loadErr.message : String(loadErr);
          let code = loadErr?.data?.code ?? loadErr?.code;
          if (!code) { try { code = JSON.parse(errStr)?.code; } catch { /* ignore */ } }
          const alreadyLoaded = code === -32602 || /already loaded/i.test(errStr);
          if (alreadyLoaded) {
            sess.sessionId = savedSessionId;
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
        sess.activeTurn = null;
        sess.phase = 'idle';
        proc.knownSessions.add(session.sessionId);
        // Update SQLite with the new sessionId
        if (body?.chatId) {
          updateChatAgentSession(userId, String(body.chatId), agentId, session.sessionId).catch(() => { /* ignore */ });
        }
        console.log(`[ACP:${agentId}] Fallback new session ${session.sessionId} for user ${userId}`);
        return NextResponse.json({ ok: true, sessionId: session.sessionId, loaded: false });
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
