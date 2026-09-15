'use client';

import { forwardRef } from 'react';
import './ChatLoadingView.css';

export const ChatLoadingView = forwardRef<HTMLDivElement, { chatName: string }>(
  function ChatLoadingView({ chatName }, ref) {
    const label = `Loading ${chatName}`;
    return (
      <div
        ref={ref}
        className="chatLoadingView"
        role="status"
        aria-label={label}
        aria-live="polite"
        aria-busy="true"
        tabIndex={-1}
      >
        <span className="chatLoadingTrack" aria-hidden="true">
          <span className="chatLoadingSpinner" />
        </span>
        <span className="chatLoadingLabel">{label}...</span>
      </div>
    );
  },
);
