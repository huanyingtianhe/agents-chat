'use client';

import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
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
  const localWrapRef = useRef<HTMLSpanElement | null>(null);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!isOpen) return;

    function updatePosition() {
      const wrap = localWrapRef.current;
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const minWidth = Math.max(180, rect.width);
      const left = Math.min(Math.max(8, rect.left), window.innerWidth - minWidth - 8);
      setDropdownStyle({
        left,
        bottom: Math.max(8, window.innerHeight - rect.top + 6),
        minWidth,
      });
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen]);

  if (models.length === 0) return null;
  
  const selectedModel = models.find((model) => model.modelId === selectedModelId) || models[0];
  const selectedModelLabel = selectedModel?.name || selectedModel?.modelId || '';
  const portalHost = typeof document !== 'undefined' ? document.querySelector('.chatPageRoot') || document.body : null;
  const dropdown = isOpen && dropdownStyle ? (
    <div
      className="agentModelDropdown agentModelDropdownPortal"
      role="listbox"
      aria-label={`Model for ${agentId}`}
      style={dropdownStyle}
      onMouseDown={(event) => event.stopPropagation()}
    >
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
  ) : null;

  return (
    <span
      className="agentModelSelectWrap"
      ref={(el) => { localWrapRef.current = el; wrapRef?.(el); }}
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
      {dropdown && portalHost ? createPortal(dropdown, portalHost) : null}
    </span>
  );
}
