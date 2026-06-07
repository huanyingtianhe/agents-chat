import { readdir, readFile } from 'fs/promises';
import path from 'path';
import { validateWorkflowPlan } from './workflowSchema.mjs';

const WORKFLOWS_DIR = path.join(process.cwd(), 'workflows');

export async function loadRepoWorkflows() {
  let entries = [];
  try {
    entries = await readdir(WORKFLOWS_DIR);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const files = entries.filter((e) => e.endsWith('.workflow.json'));
  const out = [];
  for (const f of files) {
    const full = path.join(WORKFLOWS_DIR, f);
    try {
      const raw = await readFile(full, 'utf-8');
      const parsed = JSON.parse(raw);
      const res = validateWorkflowPlan(parsed);
      if (!res.ok) {
        console.warn(`[repoWorkflows] skipping ${f}: ${res.error.message}`);
        continue;
      }
      const fallbackName = f.replace(/\.workflow\.json$/, '');
      const name = res.plan.name ?? fallbackName;
      out.push({
        name,
        source: 'repo',
        filePath: full,
        plan: { ...res.plan, name },
      });
    } catch (err) {
      console.warn(`[repoWorkflows] failed to load ${f}:`, err);
    }
  }
  return out;
}
