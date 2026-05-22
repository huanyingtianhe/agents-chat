export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureRuntime } = await import("./lib/scheduler/schedulerRuntime");
  await ensureRuntime();
}
