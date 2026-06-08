'use client';

import type { ReactNode } from 'react';

export type StatusBarProps = {
  statusText: string;
  targetText: string;
  isRunning: boolean;
  planSlot?: ReactNode | null;
};

export function StatusBar({ statusText, targetText, isRunning, planSlot }: StatusBarProps) {
  return (
    <footer className="statusBar">
      <div className="statusGroup">
        <span className={`statusDot ${isRunning ? 'connected' : ''}`} />
        <span>{statusText}</span>
      </div>
      {planSlot ? <div className="statusPlanSlot">{planSlot}</div> : null}
      <span>{targetText}</span>
    </footer>
  );
}
