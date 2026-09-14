'use client';

import { useEffect, useState } from 'react';
import type { StorageUnavailableError } from '../../chat/chatApi';

export type StorageUnavailableBannerProps = {
  error: StorageUnavailableError | null;
  onRetry: () => Promise<void> | void;
};

export function StorageUnavailableBanner({ error, onRetry }: StorageUnavailableBannerProps) {
  const [dismissedError, setDismissedError] = useState<StorageUnavailableError | null>(null);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (error && error !== dismissedError) setDismissedError(null);
  }, [error, dismissedError]);

  if (!error || dismissedError === error) return null;

  async function retry() {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <section className="storageUnavailableBanner" role="alert" aria-live="assertive">
      <div className="storageUnavailableMarker" aria-hidden="true">
        <span />
      </div>
      <div className="storageUnavailableCopy">
        <strong>Storage connection interrupted</strong>
        <p>
          Stored chats and agent configuration are temporarily unavailable. Your existing data has not been replaced.
          Ask the server operator to run <code>npm run diagnose</code>, then retry.
        </p>
      </div>
      <div className="storageUnavailableActions">
        <button type="button" className="storageUnavailableRetry" onClick={() => void retry()} disabled={retrying}>
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
        <button type="button" className="storageUnavailableDismiss" onClick={() => setDismissedError(error)}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
