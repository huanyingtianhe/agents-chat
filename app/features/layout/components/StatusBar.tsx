'use client';

export type StatusBarProps = {
  statusText: string;
  targetText: string;
  isRunning: boolean;
};

export function StatusBar({ statusText, targetText, isRunning }: StatusBarProps) {
  return (
    <footer className="statusBar">
      <div className="statusGroup">
        <span className={`statusDot ${isRunning ? 'connected' : ''}`} />
        <span>{statusText}</span>
      </div>
      <span>{targetText}</span>
    </footer>
  );
}
