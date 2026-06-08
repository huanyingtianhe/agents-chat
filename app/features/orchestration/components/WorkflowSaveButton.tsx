'use client';

import { useMemo, useState } from 'react';
import { parseSchedulerPlanResponse } from '@/lib/workflow/scheduler.mjs';

type Props = {
  content: string;
};

export function WorkflowSaveButton({ content }: Props) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const plan = useMemo(() => {
    if (!content || content.length < 10) return null;
    if (!content.includes('"nodes"')) return null;
    const r = parseSchedulerPlanResponse(content);
    return r.ok ? r.plan : null;
  }, [content]);

  if (!plan) return null;

  async function save() {
    if (!plan) return;
    const name = window.prompt('Save workflow as:', plan.name || 'my-workflow');
    if (!name) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/workflows', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, plan: { ...plan, name } }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'save failed');
      setMsg('Saved ✓');
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      setMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="messageCopyButton"
        aria-label="Save as workflow"
        title="Save this plan as a reusable workflow"
        onClick={save}
        disabled={saving}
      >
        💾 {saving ? 'Saving…' : 'Save as workflow'}
      </button>
      {msg && <span className="messageMetaTag">{msg}</span>}
    </>
  );
}
