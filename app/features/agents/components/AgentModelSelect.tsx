'use client';

import type { AgentModel } from '../agentTypes';

interface AgentModelSelectProps {
  agentId: string;
  models: AgentModel[];
  selectedModelId: string;
  isOpen: boolean;
  onToggle: () => void;
  onSelectModel: (modelId: string) => void;
  wrapRef?: (el: HTMLSpanElement | null) => void;
  isEnsuring?: boolean;
}

export function AgentModelSelect({
  agentId,
  models,
  selectedModelId,
  isOpen,
  onToggle,
  onSelectModel,
  wrapRef,
  isEnsuring,
}: AgentModelSelectProps) {
  if (models.length === 0) return null;
  
  const selectedModel = models.find((model) => model.modelId === selectedModelId) || models[0];
  const selectedModelLabel = selectedModel?.name || selectedModel?.modelId || '';

  return (
    <span
      className="agentModelSelectWrap"
      ref={wrapRef}
    >
      <button
        type="button"
        className={`agentModelSelect ${isOpen ? 'agentModelSelectOpen' : ''}`}
        data-testid="agent-model-select"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`Model for ${agentId}`}
        title={`Model for @${agentId}`}
        onClick={onToggle}
        disabled={isEnsuring}
      >
        <span className="agentModelSelectLabel">{selectedModelLabel}</span>
        <span className="agentModelSelectCaret" aria-hidden="true">▾</span>
      </button>
      {isOpen && (
        <div className="agentModelDropdown" role="listbox" aria-label={`Model for ${agentId}`}>
          {models.map((model) => {
            const isSelected = model.modelId === selectedModelId;
            return (
              <button
                key={model.modelId}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`agentModelOption ${isSelected ? 'agentModelOptionActive' : ''}`}
                title={model.description || model.modelId}
                onClick={() => onSelectModel(model.modelId)}
              >
                <span className="agentModelOptionLabel">{model.name || model.modelId}</span>
                {isSelected ? <span className="agentModelOptionCheck">✓</span> : null}
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
