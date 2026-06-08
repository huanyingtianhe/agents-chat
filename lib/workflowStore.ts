import * as crypto from 'crypto';
import Database from 'better-sqlite3';
import { getDb } from './chatStore';
import { validateWorkflowPlan } from './workflow/workflowSchema.mjs';
import type { WorkflowPlan } from './workflow/workflowTypes.mjs';

export type UserWorkflow = {
  id: string;
  name: string;
  plan: WorkflowPlan;
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: string;
  name: string;
  plan_json: string;
  created_at: number;
  updated_at: number;
};

function row2wf(r: Row): UserWorkflow {
  return {
    id: r.id,
    name: r.name,
    plan: JSON.parse(r.plan_json) as WorkflowPlan,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function db(): Database.Database {
  return getDb();
}

export function listUserWorkflows(userId: string): UserWorkflow[] {
  const rows = db()
    .prepare(
      'SELECT id, name, plan_json, created_at, updated_at FROM user_workflows WHERE user_id = ? ORDER BY updated_at DESC',
    )
    .all(userId) as Row[];
  return rows.map(row2wf);
}

export function getUserWorkflow(userId: string, id: string): UserWorkflow | null {
  const row = db()
    .prepare(
      'SELECT id, name, plan_json, created_at, updated_at FROM user_workflows WHERE user_id = ? AND id = ?',
    )
    .get(userId, id) as Row | undefined;
  return row ? row2wf(row) : null;
}

export type SaveResult =
  | { ok: true; workflow: UserWorkflow }
  | { ok: false; error: string };

export function saveUserWorkflow(
  userId: string,
  input: { id?: string; name: string; plan: unknown },
): SaveResult {
  const res = validateWorkflowPlan(input.plan);
  if (!res.ok) return { ok: false, error: res.error.message };
  if (!input.name || typeof input.name !== 'string') {
    return { ok: false, error: 'name is required' };
  }
  const now = Date.now();
  const id = input.id || crypto.randomUUID();
  const planJson = JSON.stringify({ ...res.plan, name: input.name });
  const existing = db()
    .prepare('SELECT created_at FROM user_workflows WHERE user_id = ? AND id = ?')
    .get(userId, id) as { created_at: number } | undefined;
  const createdAt = existing?.created_at ?? now;
  db()
    .prepare(
      `INSERT INTO user_workflows (id, user_id, name, plan_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, plan_json = excluded.plan_json, updated_at = excluded.updated_at`,
    )
    .run(id, userId, input.name, planJson, createdAt, now);
  const saved = getUserWorkflow(userId, id);
  if (!saved) return { ok: false, error: 'save_failed' };
  return { ok: true, workflow: saved };
}

export function deleteUserWorkflow(userId: string, id: string): boolean {
  const r = db()
    .prepare('DELETE FROM user_workflows WHERE user_id = ? AND id = ?')
    .run(userId, id);
  return r.changes > 0;
}
