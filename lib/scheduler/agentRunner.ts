import { getAllAgents } from "../configStore";
import type { CronJob } from "../../app/features/scheduler/scheduleTypes";

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
  agent: any,
  modelId: string,
  prompt: string,
  append: (s: string) => void,
  resolve: (text: string) => void,
  reject: (e: Error) => void
): Promise<void> {
  // TBD: To be filled in by a follow-up task. Compose lib/acp/* primitives
  // (rpc, runtimeState, models, attachments) to spawn the agent process,
  // run initialize -> session/new -> session/prompt with `prompt`,
  // collect session/update text chunks via `append`, and resolve with the
  // final assistant reply text. Reference: app/api/acp/route.ts.
  throw new Error("agentRunner: ACP wiring not yet implemented");
}
