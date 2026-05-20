'use client';

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { AgentModel } from '../../agents/agentTypes';
import { AgentModelSelect } from '../../agents/components/AgentModelSelect';
import type { OrchestrationMode } from '../../chat/chatTypes';

type ComposerTargetControlsProps = {
  mentionedAgentIds: string[];
  orchestrationEnabled: boolean;
  orchestrationMode: OrchestrationMode;
  discussionRounds: number;
  effectiveComposerAgentId: string | null;
  rememberedComposerAgentId: string | null;
  currentChatId: string;
  getAgentModels: (agentId: string) => AgentModel[];
  getSelectedModelIdForAgent: (agentId: string) => string;
  openModelMenuAgentId: string | null;
  setOpenModelMenuAgentId: Dispatch<SetStateAction<string | null>>;
  modelMenuRefs: MutableRefObject<Map<string, HTMLSpanElement | null>>;
  setSelectedModelForAgent: (agentId: string, modelId: string) => void;
  clearRememberedChatAgent: (chatId: string) => void;
  setOrchestrationMode: (mode: OrchestrationMode) => void;
  setDiscussionRounds: (rounds: number) => void;
};

export function ComposerTargetControls({
  mentionedAgentIds, orchestrationEnabled, orchestrationMode, discussionRounds,
  effectiveComposerAgentId, rememberedComposerAgentId, currentChatId,
  getAgentModels, getSelectedModelIdForAgent, openModelMenuAgentId, setOpenModelMenuAgentId,
  modelMenuRefs, setSelectedModelForAgent, clearRememberedChatAgent,
  setOrchestrationMode, setDiscussionRounds,
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
            <button type="button" className={`targetPill orchPill ${orchestrationMode === 'discussion' ? 'orchPillActive' : ''}`} onClick={() => setOrchestrationMode('discussion')} title="Discussion: agents run in parallel, then a summary is generated">💬 Discussion</button>
            {orchestrationMode === 'discussion' && (
              <select className="orchRoundsSelect" value={discussionRounds} onChange={(e) => setDiscussionRounds(Number(e.target.value))} title="Number of discussion rounds">
                {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} {n === 1 ? 'round' : 'rounds'}</option>)}
              </select>
            )}
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
            title="Use the chat primary/default agent instead"
            onClick={() => clearRememberedChatAgent(currentChatId)}
          />
        ) : null}
      </span>
    </div>
  );
}
