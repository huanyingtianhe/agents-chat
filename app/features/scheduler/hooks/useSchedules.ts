"use client";
import { useCallback, useEffect, useState } from "react";
import type { CronJob, CronRun, ScheduleSpec } from "../scheduleTypes";

export function useSchedules() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/schedules");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setJobs(data.jobs ?? []);
      setError(null);
    } catch (e: any) { setError(String(e?.message ?? e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = useCallback(async (input: { agentId: string; name: string; prompt: string; scheduleSpec: ScheduleSpec; enabled?: boolean }) => {
    const r = await fetch("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!r.ok) throw new Error(await r.text());
    await refresh();
  }, [refresh]);

  const update = useCallback(async (id: string, patch: Partial<{ name: string; prompt: string; enabled: boolean; scheduleSpec: ScheduleSpec }>) => {
    const r = await fetch(`/api/schedules/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    if (!r.ok) throw new Error(await r.text());
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    const r = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error(await r.text());
    await refresh();
  }, [refresh]);

  const runNow = useCallback(async (id: string) => {
    const r = await fetch(`/api/schedules/${id}/run`, { method: "POST" });
    if (!r.ok) throw new Error(await r.text());
    await refresh();
  }, [refresh]);

  const loadDetail = useCallback(async (id: string): Promise<{ job: CronJob; runs: CronRun[] }> => {
    const r = await fetch(`/api/schedules/${id}`);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }, []);

  return { jobs, loading, error, refresh, create, update, remove, runNow, loadDetail };
}
