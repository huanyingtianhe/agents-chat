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

    let animationFrame = 0;
    function updatePosition() {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const wrap = localWrapRef.current;
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        const visualViewport = window.visualViewport;
        const viewportLeft = visualViewport?.offsetLeft ?? 0;
        const viewportTop = visualViewport?.offsetTop ?? 0;
        const viewportWidth = visualViewport?.width ?? window.innerWidth;
        const viewportHeight = visualViewport?.height ?? window.innerHeight;
        const portalHost = wrap.closest('.page');
        const hostRect = portalHost?.getBoundingClientRect() ?? {
          top: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
          left: 0,
        };
        const availableWidth = Math.max(0, viewportWidth - 16);
        const minWidth = Math.min(Math.max(180, rect.width), availableWidth);
        const viewportLeftPosition = Math.min(
          Math.max(viewportLeft + 8, rect.left),
          viewportLeft + viewportWidth - minWidth - 8,
        );
        const spaceAbove = Math.max(0, rect.top - viewportTop - 14);
        const spaceBelow = Math.max(0, viewportTop + viewportHeight - rect.bottom - 14);
        const openAbove = spaceAbove >= 96 || spaceAbove >= spaceBelow;
        setDropdownStyle({
          left: viewportLeftPosition - hostRect.left,
          top: openAbove ? 'auto' : rect.bottom - hostRect.top + 6,
          bottom: openAbove ? hostRect.bottom - rect.top + 6 : 'auto',
          minWidth,
          maxHeight: openAbove ? spaceAbove : spaceBelow,
        });
      });
    }

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.visualViewport?.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('scroll', updatePosition);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.visualViewport?.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('scroll', updatePosition);
    };
  }, [isOpen]);

  if (models.length === 0) return null;
  
  const selectedModel = models.find((model) => model.modelId === selectedModelId) || models[0];
  const selectedModelLabel = selectedModel?.name || selectedModel?.modelId || '';
  const portalHost = typeof document !== 'undefined' ? localWrapRef.current?.closest('.page') || document.querySelector('.chatPageRoot .page') || document.body : null;
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
