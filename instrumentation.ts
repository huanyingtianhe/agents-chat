export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const cron = await import("node-cron");
  const { openScheduleStore } = await import("./lib/scheduler/scheduleStore");
  const { createRuntime, setRuntime, getRuntime } = await import("./lib/scheduler/schedulerRuntime");
  const { runAgentOnce } = await import("./lib/scheduler/agentRunner");
  if (getRuntime()) return;
  const store = openScheduleStore();
  const runtime = createRuntime({
    store,
    runner: { runAgentOnce },
    cron: { schedule: (expr, fn, opts) => cron.schedule(expr, fn, opts as any) },
    now: () => Date.now(),
  });
  setRuntime(runtime);
  await runtime.start();
}
