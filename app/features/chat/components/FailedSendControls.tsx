'use client';

import type { ChatMessage } from '../chatTypes';

export type FailedSendState = {
  error: string;
  resendDisabled: boolean;
  waitingForAgents: boolean;
};

type FailedSendNoticeProps = {
  failure: FailedSendState | null;
};

type FailedSendActionsProps = {
  message: ChatMessage;
  failure: FailedSendState | null;
  onResend: (message: ChatMessage) => void;
};

export function FailedSendNotice({ failure }: FailedSendNoticeProps) {
  if (!failure) return null;

  return (
    <div className="userSendFailure userSendFailureNotice">
      <div className="userSendFailureCard" role="status" aria-label={`Failed to send: ${failure.error}`} title={failure.error}>
        <span className="userSendFailureStatus">
          Failed to send: {failure.error}
        </span>
      </div>
    </div>
  );
}

export function FailedSendActions({ message, failure, onResend }: FailedSendActionsProps) {
  if (!failure) return null;

  return (
    <div className="userSendFailureActions">
      <button
        type="button"
        className="userSendFailureButton"
        disabled={failure.resendDisabled}
        title={failure.waitingForAgents ? 'Waiting for agents to load' : 'Retry sending this message'}
        onClick={() => onResend(message)}
      >
        Retry
      </button>
    </div>
  );
}
