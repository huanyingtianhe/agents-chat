'use client';

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AgentModel } from '../../agents/agentTypes';
import { AgentModelSelect } from '../../agents/components/AgentModelSelect';
import type { OrchestrationMode } from '../../chat/chatTypes';

type ComposerTargetControlsProps = {
  mentionedAgentIds: string[];
  orchestrationEnabled: boolean;
  orchestrationMode: OrchestrationMode;
  effectiveComposerAgentId: string | null;
  rememberedComposerAgentId: string | null;
  currentChatId: string;
  getAgentModels: (agentId: string) => AgentModel[];
  getSelectedModelIdForAgent: (agentId: string) => string;
  openModelMenuAgentId: string | null;
  setOpenModelMenuAgentId: Dispatch<SetStateAction<string | null>>;
  modelMenuRefs: MutableRefObject<Map<string, HTMLSpanElement | null>>;
  setSelectedModelForAgent: (agentId: string, modelId: string) => void;
  clearLastUsedAgent: () => void;
  setOrchestrationMode: (mode: OrchestrationMode) => void;
};

export function ComposerTargetControls({
  mentionedAgentIds, orchestrationEnabled, orchestrationMode,
  effectiveComposerAgentId, rememberedComposerAgentId, currentChatId,
  getAgentModels, getSelectedModelIdForAgent, openModelMenuAgentId, setOpenModelMenuAgentId,
  modelMenuRefs, setSelectedModelForAgent, clearLastUsedAgent,
  setOrchestrationMode,
}: ComposerTargetControlsProps) {
  const modelSelect = (agentId: string) => (
    <AgentModelSelect
      agentId={agentId}
      models={getAgentModels(agentId)}
      selectedModelId={getSelectedModelIdForAgent(agentId)}
      isOpen={openModelMenuAgentId === agentId}
      onToggle={() => setOpenModelMenuAgentId((p) => (p === agentId ? null : agentId))}
      onSelectModel={(modelId) => { setSelectedModelForAgent(agentId, modelId); setOpenModelMenuAgentId(null); }}
      wrapRef={(el) => modelMenuRefs.current.set(agentId, el)}
    />
  );

  if (mentionedAgentIds.length > 0) {
    return (
      <div className="targetPills">
        {mentionedAgentIds.map((agentId) => (
          <span key={agentId} className="targetPill modelTargetPill">
            <span>@{agentId}</span>{modelSelect(agentId)}
          </span>
        ))}
        {orchestrationEnabled && (
          <>
            <button type="button" className={`targetPill orchPill ${orchestrationMode === 'auto' ? 'orchPillActive' : ''}`} onClick={() => setOrchestrationMode('auto')} title="Auto: a scheduler decides which agent to call next based on results">🧠 Auto</button>
            <button type="button" className={`targetPill orchPill ${orchestrationMode === 'pipeline' ? 'orchPillActive' : ''}`} onClick={() => setOrchestrationMode('pipeline')} title="Pipeline: agents run sequentially, each receives the previous agent's output">🔀 Pipeline</button>
          </>
        )}
      </div>
    );
  }

  if (!effectiveComposerAgentId) return null;
  return (
    <div className="targetPills">
      <span className="targetPill rememberedAgentPill modelTargetPill">
        <span>@{effectiveComposerAgentId}</span>{modelSelect(effectiveComposerAgentId)}
        {rememberedComposerAgentId ? (
          <button
            type="button"
            className="rememberedAgentRemove"
            aria-label={`Remove remembered agent ${effectiveComposerAgentId}`}
            title="Stop pre-filling this agent in the composer"
            onClick={() => clearLastUsedAgent()}
          />
        ) : null}
      </span>
    </div>
  );
}
