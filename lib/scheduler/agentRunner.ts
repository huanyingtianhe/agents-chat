import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { getAllAgents } from "../configStore.ts";
import type { AgentRecord } from "../configStore.ts";
import type { CronJob } from "../../app/features/scheduler/scheduleTypes.ts";
import { createNdjsonRpc } from "../acp/rpc.ts";

export type RunResult = {
  replyText: string;
  rawLog: string;
  error: string | null;
};

export async function runAgentOnce(job: CronJob, opts?: { timeoutMs?: number }): Promise<RunResult> {
  const timeoutMs = opts?.timeoutMs ?? 10 * 60 * 1000;
  const agents = getAllAgents();
  const agent = agents.find((a) => a.id === job.agentId);
  if (!agent) return { replyText: "", rawLog: "", error: `agent not found: ${job.agentId}` };

  const logChunks: string[] = [];
  const append = (s: string) => {
    if (logChunks.join("").length < 256 * 1024) logChunks.push(s);
  };

  try {
    const replyText = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      runViaAcpPrimitives(agent, agent.defaultModelId ?? "", job.prompt, append, resolve, reject)
        .finally(() => clearTimeout(timer));
    });
    return { replyText, rawLog: logChunks.join(""), error: null };
  } catch (e: any) {
    return { replyText: "", rawLog: logChunks.join(""), error: String(e?.message ?? e) };
  }
}

async function runViaAcpPrimitives(
  agent: AgentRecord,
  modelId: string,
  prompt: string,
  append: (s: string) => void,
  resolve: (text: string) => void,
  reject: (e: Error) => void
): Promise<void> {
  if (agent.relay) {
    throw new Error(`agentRunner: relay agents are not supported for cron jobs (agent: ${agent.id})`);
  }

  // Mirror spawn logic from app/api/acp/route.ts
  const commandParts = (agent.command || 'copilot.exe').trim().split(/\s+/);
  const command = commandParts[0];
  const commandExtraArgs = commandParts.slice(1);
  const args = [...commandExtraArgs, ...(agent.args || ['--acp'])];
  if (agent.yolo && !args.includes('--yolo')) args.push('--yolo');
  const cwd = agent.cwd || process.cwd();

  if (!existsSync(cwd)) {
    throw new Error(`Agent working directory does not exist: ${cwd}`);
  }

  append(`→ spawn ${command} ${args.join(' ')}\n`);

  const cp = spawn(command, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: process.env,
    windowsHide: true,
    shell: true,
  });

  cp.stderr?.on('data', () => { /* discard stderr */ });

  const rpc = createNdjsonRpc(cp);

  let done = false;
  let replyText = '';

  function finish(text: string): void {
    if (done) return;
    done = true;
    resolve(text);
  }

  function fail(err: Error): void {
    if (done) return;
    done = true;
    reject(err);
  }

  cp.on('exit', (code) => {
    // Unblock any in-flight rpc.send calls, then propagate the exit as a failure.
    rpc.destroy();
    fail(new Error(`Agent process exited prematurely (code ${code})`));
  });

  // Handle server-side requests from the agent (e.g. permission prompts, fs/terminal tools).
  rpc.onRequest = (method: string, params: Record<string, unknown>, id: number | string) => {
    if (method === 'session/request_permission') {
      if (agent.yolo) {
        // Auto-approve: prefer allow_always → allow_once → allow (mirrors route.ts logic)
        const options: Array<{ optionId: string; kind?: string }> =
          Array.isArray(params?.options) ? (params.options as Array<{ optionId: string; kind?: string }>) : [];
        const allowOption =
          options.find(o => o.kind === 'allow_always' || o.optionId === 'allow_always') ??
          options.find(o => o.kind === 'allow_once'   || o.optionId === 'allow_once') ??
          options.find(o => o.kind === 'allow'        || o.optionId === 'allow');
        const optionId = allowOption?.optionId ?? 'allow_once';
        append(`← permission request auto-approved (${optionId})\n`);
        rpc.respond(id, { outcome: { outcome: 'selected', optionId } });
      } else {
        // Non-yolo: deny and abort the run so it doesn't hang waiting for a user.
        const options: Array<{ optionId: string; kind?: string }> =
          Array.isArray(params?.options) ? (params.options as Array<{ optionId: string; kind?: string }>) : [];
        const denyOption = options.find(o => o.kind === 'reject_once' || o.optionId === 'reject_once');
        append(`← permission request denied (non-yolo agent)\n`);
        rpc.respond(id, { outcome: { outcome: 'selected', optionId: denyOption?.optionId ?? 'reject_once' } });
        fail(new Error('agentRunner: agent requested permission but agent is not in yolo mode; aborting cron run'));
      }
    } else if (
      method === 'fs/read_text_file' ||
      method === 'fs/write_text_file' ||
      method.startsWith('terminal/')
    ) {
      // No tool access during cron runs — respond with error so agent doesn't hang.
      append(`← ${method} denied (no tool access in cron runs)\n`);
      rpc.respond(id, { error: 'Tool access is not available in cron runs' });
    } else {
      append(`← unknown request: ${method}\n`);
      rpc.respond(id, {});
    }
  };

  // Collect text chunks from session/update notifications.
  rpc.onNotification = (method: string, params: Record<string, unknown>) => {
    if (method !== 'session/update') return;
    const update = (params as Record<string, unknown>)?.update as Record<string, unknown> | undefined;
    const kind = update?.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const content = update?.content as Record<string, unknown> | undefined;
      if (content?.type === 'text') {
        const chunk = (content.text as string) ?? '';
        replyText += chunk;
        append(`← text: ${chunk.slice(0, 80)}${chunk.length > 80 ? '…' : ''}\n`);
      }
    } else if (kind === 'agent_thought_chunk') {
      const content = update?.content as Record<string, unknown> | undefined;
      if (content?.type === 'text') {
        append(`← thinking: ${((content.text as string) ?? '').slice(0, 80)}\n`);
      }
    }
  };

  try {
    // 1. initialize
    append('→ initialize\n');
    await rpc.send('initialize', { protocolVersion: 1, clientCapabilities: {} });
    append('← initialize ok\n');

    // 2. session/new
    append('→ session/new\n');
    const sessionResult = await rpc.send('session/new', { cwd, mcpServers: [] }) as Record<string, unknown>;
    const sessionId = typeof sessionResult?.sessionId === 'string' ? sessionResult.sessionId : null;
    if (!sessionId) throw new Error('session/new did not return a sessionId');
    append(`← session/new: ${sessionId}\n`);

    // 3. Optionally set model — mirrors applySessionModelIfRequested in lib/acp/models.ts
    if (modelId) {
      append(`→ session/set_model (${modelId})\n`);
      try {
        await rpc.send('session/set_model', { sessionId, modelId });
        append('← session/set_model ok\n');
      } catch {
        // Fallback to legacy method name (same pattern as applySessionModelIfRequested)
        await rpc.send('unstable_setSessionModel', { sessionId, modelId });
        append('← unstable_setSessionModel ok\n');
      }
    }

    // 4. session/prompt — no timeout (0 = disabled), same as route.ts
    append('→ session/prompt\n');
    const result = await rpc.send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    }, 0) as Record<string, unknown> | undefined;

    const stopReason = result?.stopReason ?? 'unknown';
    append(`✓ done (stopReason=${stopReason})\n`);
    finish(replyText);
  } catch (e: unknown) {
    fail(e instanceof Error ? e : new Error(String(e)));
  } finally {
    try { cp.kill(); } catch { /* ignore */ }
  }
}
