'use client';

import type { ReactNode } from 'react';

export type StatusBarProps = {
  statusText: string;
  targetText: string;
  isRunning: boolean;
  gitContextSlot?: ReactNode | null;
  planSlot?: ReactNode | null;
};

export function StatusBar({ statusText, targetText, isRunning, gitContextSlot, planSlot }: StatusBarProps) {
  return (
    <footer className="statusBar">
      <div className="statusLeft">
        {gitContextSlot ? <div className="statusGitContextSlot">{gitContextSlot}</div> : null}
      </div>
      <div className="statusRight">
        <div className="statusGroup">
          <span className={`statusDot ${isRunning ? 'connected' : ''}`} />
          <span>{statusText}</span>
        </div>
        {planSlot ? <div className="statusPlanSlot">{planSlot}</div> : null}
        <span className="statusTargetText">{targetText}</span>
      </div>
    </footer>
  );
}
