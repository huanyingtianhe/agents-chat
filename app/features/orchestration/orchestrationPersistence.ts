import type { OrchestrationState } from '../chat/chatTypes';
import type { NodeStatus } from '@/lib/workflow/workflowTypes.mjs';

/**
 * Diff-based per-node persistence. Writes only what changed since the last
 * successful PATCH for this tab. Caches are module-scoped so they survive
 * hook remounts within one tab. No cross-tab sync.
 */

type NodeSnapshot = Record<string, { status: NodeStatus; result: string | null }>;
type ParentSnapshot = { mode: string; summaryStarted: boolean; planHash: string };

const nodeCache = new Map<string, NodeSnapshot>();
const parentCache = new Map<string, ParentSnapshot>();

function hashPlan(plan: unknown): string {
  // tiny, fast non-cryptographic hash — only used to detect plan changes
  const s = JSON.stringify(plan ?? null);
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

/** Strip transient/runtime-only fields to compute the persisted plan blob. */
function extractPlanBlob(state: OrchestrationState): unknown {
  const {
    id: _id,
    mode: _mode,
    sourceChatId: _scId,
    summaryStarted: _ss,
    nodeStatuses: _ns,
    results: _r,
    ...plan
  } = state;
  return plan;
}

async function putParent(state: OrchestrationState): Promise<boolean> {
  if (!state.sourceChatId) return false;
  const plan = extractPlanBlob(state);
  try {
    const res = await fetch('/api/orchestrations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: state.id,
        chatId: state.sourceChatId,
        mode: state.mode,
        plan,
        summaryStarted: !!state.summaryStarted,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function patchNode(
  orchId: string,
  nodeId: string,
  status: NodeStatus,
  result: string | null,
): Promise<boolean> {
  try {
    const res = await fetch(
      `/api/orchestrations/${encodeURIComponent(orchId)}/nodes/${encodeURIComponent(nodeId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, result }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Diff current state against caches; PUT the parent if mode/plan/summary
 * changed; PATCH each changed node in parallel. Updates caches only on 2xx
 * so transient failures are retried on the next call.
 *
 * Only acts on workflow-mode orchestrations.
 */
export async function persistOrchestrationDiff(state: OrchestrationState): Promise<void> {
  if (state.mode !== 'workflow') return;
  if (!state.sourceChatId) return;

  const orchId = state.id;
  const planHash = hashPlan(extractPlanBlob(state));
  const parentSnap = parentCache.get(orchId);
  const parentChanged =
    !parentSnap ||
    parentSnap.mode !== state.mode ||
    parentSnap.summaryStarted !== !!state.summaryStarted ||
    parentSnap.planHash !== planHash;

  if (parentChanged) {
    const ok = await putParent(state);
    if (ok) {
      parentCache.set(orchId, {
        mode: state.mode,
        summaryStarted: !!state.summaryStarted,
        planHash,
      });
    } else {
      // Parent must exist before nodes can be PATCHed (FK in DB).
      // Bail; next call will retry.
      return;
    }
  }

  const currentNodes = state.nodeStatuses || {};
  const currentResults = state.results || {};
  const snap = nodeCache.get(orchId) || {};
  const changes: Array<{ nodeId: string; status: NodeStatus; result: string | null }> = [];

  for (const nodeId of Object.keys(currentNodes)) {
    const status = currentNodes[nodeId];
    const result = currentResults[nodeId] ?? null;
    const prev = snap[nodeId];
    if (!prev || prev.status !== status || prev.result !== result) {
      changes.push({ nodeId, status, result });
    }
  }

  if (changes.length === 0) return;

  const results = await Promise.all(
    changes.map((c) => patchNode(orchId, c.nodeId, c.status, c.result)),
  );

  // Update cache only for successful PATCHes; failed ones get retried.
  const newSnap: NodeSnapshot = { ...snap };
  for (let i = 0; i < changes.length; i++) {
    if (results[i]) {
      const c = changes[i];
      newSnap[c.nodeId] = { status: c.status, result: c.result };
    }
  }
  nodeCache.set(orchId, newSnap);
}

/** Load and rebuild orchestrations for a chat; seed both caches. */
export async function loadPersistedOrchestrations(chatId: string): Promise<OrchestrationState[]> {
  try {
    const res = await fetch(`/api/orchestrations?chatId=${encodeURIComponent(chatId)}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (!data?.ok || !Array.isArray(data.items)) return [];

    const out: OrchestrationState[] = [];
    for (const it of data.items) {
      const s = it.state as OrchestrationState;
      if (!s || !s.id) continue;
      out.push(s);

      // Seed caches: server's view IS "last persisted".
      parentCache.set(s.id, {
        mode: s.mode,
        summaryStarted: !!s.summaryStarted,
        planHash: hashPlan(extractPlanBlob(s)),
      });
      const snap: NodeSnapshot = {};
      for (const nodeId of Object.keys(s.nodeStatuses || {})) {
        snap[nodeId] = {
          status: (s.nodeStatuses as Record<string, NodeStatus>)[nodeId],
          result: (s.results || {})[nodeId] ?? null,
        };
      }
      nodeCache.set(s.id, snap);
    }
    return out;
  } catch {
    return [];
  }
}

/** Test/debug only — clear in-tab caches. */
export function _resetPersistenceCaches(): void {
  nodeCache.clear();
  parentCache.clear();
}

