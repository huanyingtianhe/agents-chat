import * as configStore from '@/lib/configStore';
import type { AgentConfig, AgentModel, AgentProcess } from './types';
import { getAgentProcesses } from './runtimeState';

function ts(): string { return new Date().toISOString().slice(11, 23); }
const log = (...args: unknown[]) => console.log(`[${ts()}]`, ...args);

export function normalizeSessionModels(input: unknown): AgentModel[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const models: AgentModel[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    models.push({
      modelId,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
    });
  }
  return models;
}

export function syncAgentModelsFromSessionResult(agentId: string, sessionResult: unknown): { models: AgentModel[]; defaultModelId: string } | null {
  const session = sessionResult && typeof sessionResult === 'object' ? sessionResult as Record<string, any> : null;
  const modelState = session?.models && typeof session.models === 'object' ? session.models as Record<string, unknown> : null;
  const availableModels = normalizeSessionModels(modelState?.availableModels);
  if (availableModels.length === 0) return null;
  const currentModelId = typeof modelState?.currentModelId === 'string' ? modelState.currentModelId.trim() : '';
  const defaultModelId = currentModelId && availableModels.some(model => model.modelId === currentModelId)
    ? currentModelId
    : availableModels[0].modelId;
  configStore.updateAgent(agentId, { models: availableModels, defaultModelId });
  const proc = getAgentProcesses().get(agentId);
  if (proc) {
    proc.config = { ...proc.config, models: availableModels, defaultModelId };
  }
  log(`[ACP:${agentId}] Synced ${availableModels.length} model(s) from session/new; default=${defaultModelId}`);
  return { models: availableModels, defaultModelId };
}

export function validateRequestedModel(config: AgentConfig, requested: unknown): string | undefined {
  const modelId = typeof requested === 'string' ? requested.trim() : '';
  if (!modelId) return undefined;
  const models = config.models || [];
  if (models.length > 0 && !models.some(model => model.modelId === modelId)) {
    throw new Error(`Unknown modelId "${modelId}" for agent "${config.id}"`);
  }
  return modelId;
}

export async function applySessionModelIfRequested(proc: AgentProcess, sessionId: string | null, requestedModelId: string | undefined): Promise<void> {
  if (!requestedModelId) return;
  // Skip if the requested model is already the agent's default — avoids sending
  // session/set_model which can translate to an internal model name the proxy doesn't recognize.
  const defaultId = proc.config.defaultModelId || (proc.config.models?.[0]?.modelId);
  if (requestedModelId === defaultId) return;
  if (!sessionId) throw new Error('Cannot set model before session is created');
  if (!proc.rpc) throw new Error('Agent process not ready');
  log(`[ACP:${proc.config.id}] session/set_model modelId="${requestedModelId}" (default="${defaultId}") session=${sessionId}`);
  try {
    await proc.rpc.send('session/set_model', { sessionId, modelId: requestedModelId });
  } catch (firstErr: any) {
    const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    try {
      await proc.rpc.send('unstable_setSessionModel', { sessionId, modelId: requestedModelId });
    } catch (secondErr: any) {
      const secondMsg = secondErr instanceof Error ? secondErr.message : String(secondErr);
      throw new Error(`Agent does not support switching to model "${requestedModelId}" for this session (${firstMsg}; ${secondMsg})`);
    }
  }
}
