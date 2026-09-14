"use client";
import { useCallback, useEffect, useState } from "react";
import type { CronJob, CronRun, ScheduleSpec } from "../scheduleTypes";

async function responseError(response: Response): Promise<Error> {
  const text = await response.text();
  if (text) {
    try {
      const data = JSON.parse(text) as { error?: unknown };
      if (typeof data.error === "string") return new Error(data.error);
    } catch {
      return new Error(text);
    }
    return new Error(text);
  }
  return new Error(`HTTP ${response.status}`);
}

export function useSchedules(enabled = true) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/schedules");
      if (!r.ok) throw await responseError(r);
      const data = await r.json();
      setJobs(data.jobs ?? []);
      setError(null);
    } catch (e: unknown) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const create = useCallback(async (input: { agentId: string; name: string; prompt: string; scheduleSpec: ScheduleSpec; enabled?: boolean; timeoutMinutes?: number }) => {
    const r = await fetch("/api/schedules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (!r.ok) throw await responseError(r);
    await refresh();
  }, [refresh]);

  const update = useCallback(async (id: string, patch: Partial<{ name: string; prompt: string; enabled: boolean; scheduleSpec: ScheduleSpec; timeoutMinutes: number }>) => {
    const r = await fetch(`/api/schedules/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
    if (!r.ok) throw await responseError(r);
    await refresh();
  }, [refresh]);

  const remove = useCallback(async (id: string) => {
    const r = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    if (!r.ok) throw await responseError(r);
    await refresh();
  }, [refresh]);

  const runNow = useCallback(async (id: string) => {
    const r = await fetch(`/api/schedules/${id}/run`, { method: "POST" });
    if (!r.ok) throw await responseError(r);
    await refresh();
  }, [refresh]);

  const loadDetail = useCallback(async (id: string): Promise<{ job: CronJob; runs: CronRun[] }> => {
    const r = await fetch(`/api/schedules/${id}`);
    if (!r.ok) throw await responseError(r);
    return r.json();
  }, []);

  return { jobs, loading, error, refresh, create, update, remove, runNow, loadDetail };
}
