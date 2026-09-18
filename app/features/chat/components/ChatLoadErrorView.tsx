'use client';

import './ChatLoadErrorView.css';

type ChatLoadErrorViewProps = {
  chatName: string | null;
  error: string;
  onRetry: () => void;
};

export function ChatLoadErrorView({
  chatName,
  error,
  onRetry,
}: ChatLoadErrorViewProps) {
  const target = chatName || 'chat';
  return (
    <div
      className="chatLoadErrorView"
      role="alert"
      aria-label={`Failed to load ${target}`}
    >
      <strong>Could not load {target}</strong>
      <span className="chatLoadErrorDetail">{error}</span>
      <button
        type="button"
        className="chatLoadRetryButton"
        aria-label={`Retry loading ${target}`}
        onClick={onRetry}
      >
        Retry
      </button>
    </div>
  );
}
