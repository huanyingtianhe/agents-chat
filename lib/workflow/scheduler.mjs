import { validateWorkflowPlan } from './workflowSchema.mjs';

const PLAN_RULES = `Output a JSON workflow with this shape:
{ "version": 1, "nodes": [ { "id": "<id>", "agent": "<agent-id>", "instruction": "<text>", "dependsOn": ["<id>", ...] } ] }

Rules:
- Use {{input}} to reference the user's original message inside an instruction.
- Use {{<nodeId>.output}} to reference an upstream node's output. The referenced node MUST be in dependsOn (transitively).
- Maximize parallelism: ONLY add a dependsOn entry when the downstream node actually needs the upstream output.
- Use agent ids from the list below — do NOT invent agents.
- Node ids are short, kebab-case, unique.
- Return JSON ONLY — no prose, no commentary.`;

function agentBlock(agents) {
  return agents.map((a) => `- ${a.id}: ${a.description}`).join('\n');
}

export function buildPlanPrompt(args) {
  return `You are a workflow planner.

User message:
${args.userMessage}

Available agents:
${agentBlock(args.agents)}

${PLAN_RULES}`;
}

export function buildReplanPrompt(args) {
  const completedBlock = Object.entries(args.completedOutputs)
    .map(([id, out]) => `### ${id}\n${out}`)
    .join('\n\n') || '(none)';
  return `You are a workflow planner. A previous plan failed at one node and you must produce a REVISED plan for the remaining work.

Original user message:
${args.userMessage}

Available agents:
${agentBlock(args.agents)}

Previous plan:
${JSON.stringify(args.originalPlan, null, 2)}

Failed node id: ${args.failedNodeId}
Failure message: ${args.failureMessage}

Outputs already produced (these will be reused — do not recompute them; you may reference {{<id>.output}} if your new nodes dependsOn them):
${completedBlock}

${PLAN_RULES}`;
}

export function parseSchedulerPlanResponse(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : raw).trim();
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `failed to parse scheduler response as JSON: ${msg}` };
  }
  const res = validateWorkflowPlan(parsed);
  if (!res.ok) return { ok: false, error: `invalid plan: ${res.error.message}` };
  return { ok: true, plan: res.plan };
}
