'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentUserRequest, AgentUserRequestResponse } from '../../chat/chatTypes';
import { getAgentUserRequestOptionLabel } from '../../chat/chatHelpers';

export function AgentUserRequestCard({
  request,
  disabled,
  onAnswer,
  onDismiss: _onDismiss,
}: {
  request: AgentUserRequest;
  disabled: boolean;
  onAnswer: (requestId: string, response: AgentUserRequestResponse) => Promise<void>;
  onDismiss: (requestId: string) => void;
}) {
  const [isPending, setIsPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const isSubmitting = disabled || isPending;
  const structuredQuestions = Array.isArray(request.questions) ? request.questions : [];

  useEffect(() => {
    pendingRef.current = false;
    setIsPending(false);
    setSubmitError(null);
  }, [request.id]);

  async function handleAnswer(response: AgentUserRequestResponse) {
    if (disabled || pendingRef.current) return;
    pendingRef.current = true;
    setIsPending(true);
    setSubmitError(null);
    try {
      await onAnswer(request.id, response);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Failed to answer agent request');
    } finally {
      pendingRef.current = false;
      setIsPending(false);
    }
  }

  return (
    <div className="agentUserRequestCard">
      <div className="agentUserRequestHeader">{request.title}</div>
      <div className="agentUserRequestPrompt">{request.prompt}</div>
      {structuredQuestions.length > 0 ? (
        <form
          key={request.id}
          className="agentUserRequestForm structured"
          onSubmit={(e) => {
            e.preventDefault();
            if (isSubmitting) return;
            const form = e.currentTarget;
            const answers: Record<string, import('../../chat/chatTypes').AgentUserRequestAnswer> = {};
            let hasAnswer = false;
            structuredQuestions.forEach((question, index) => {
              const fieldName = `question-${index}`;
              const questionOptions = Array.isArray(question.options) ? question.options : [];
              if (questionOptions.length > 0) {
                const select = form.elements.namedItem(fieldName) as HTMLSelectElement | null;
                const selected = select ? Array.from(select.selectedOptions).map((option) => option.value).filter(Boolean) : [];
                const freeformInput = form.elements.namedItem(`${fieldName}-freeform`) as HTMLInputElement | null;
                const freeText = freeformInput?.value.trim() || null;
                const skipped = selected.length === 0 && !freeText;
                if (!skipped) hasAnswer = true;
                answers[question.header] = { selected, freeText, skipped };
                return;
              }
              const input = form.elements.namedItem(fieldName) as HTMLInputElement | null;
              const freeText = input?.value.trim() || null;
              const skipped = !freeText;
              if (!skipped) hasAnswer = true;
              answers[question.header] = { selected: [], freeText, skipped };
            });
            if (hasAnswer) void handleAnswer({ answers });
          }}
        >
          <div className="agentUserRequestQuestions">
            {structuredQuestions.map((question, index) => {
              const fieldName = `question-${index}`;
              const fieldId = `${request.id}-question-${index}`;
              const questionOptions = Array.isArray(question.options) ? question.options : [];
              return (
                <div key={`${request.id}-${question.header}-${index}`} className="agentUserRequestQuestion">
                  <label className="agentUserRequestQuestionLabel" htmlFor={fieldId}>{question.question || question.header}</label>
                  {question.message ? <div className="agentUserRequestQuestionMessage">{question.message}</div> : null}
                  {questionOptions.length > 0 ? (
                    <>
                      <select
                        id={fieldId}
                        name={fieldName}
                        className="agentUserRequestSelect"
                        aria-label={question.header}
                        multiple={question.multiSelect === true}
                        disabled={isSubmitting}
                      >
                        {question.multiSelect === true ? null : <option value="">Select an answer</option>}
                        {questionOptions.map((option) => (
                          <option key={option.optionId} value={option.label}>
                            {option.recommended ? `${option.label} (Recommended)` : option.label}
                          </option>
                        ))}
                      </select>
                      {question.allowFreeformInput !== false ? (
                        <input
                          name={`${fieldName}-freeform`}
                          className="agentUserRequestInput"
                          placeholder="Or type your answer"
                          aria-label={`${question.header} freeform answer`}
                          disabled={isSubmitting}
                        />
                      ) : null}
                    </>
                  ) : (
                    <input
                      id={fieldId}
                      name={fieldName}
                      className="agentUserRequestInput"
                      placeholder="Type your answer"
                      aria-label={question.header}
                      disabled={isSubmitting}
                    />
                  )}
                </div>
              );
            })}
          </div>
          <button type="submit" className="agentUserRequestButton" disabled={isSubmitting}>Send</button>
        </form>
      ) : request.inputKind === 'options' ? (
        <div className="agentUserRequestActions">
          {request.options.map((option) => (
            <button
              key={option.optionId}
              type="button"
              className="agentUserRequestButton"
              disabled={isSubmitting}
              onClick={() => void handleAnswer({ optionId: option.optionId })}
            >
              {getAgentUserRequestOptionLabel(option)}
            </button>
          ))}
        </div>
      ) : (
        <form
          key={request.id}
          className="agentUserRequestForm"
          onSubmit={(e) => {
            e.preventDefault();
            if (isSubmitting) return;
            const form = e.currentTarget;
            const input = form.elements.namedItem('answer') as HTMLInputElement | null;
            const answer = input?.value.trim() || '';
            if (answer) void handleAnswer({ answer });
          }}
        >
          <input
            name="answer"
            className="agentUserRequestInput"
            placeholder="Type your answer"
            aria-label={`Response to ${request.title}`}
            disabled={isSubmitting}
          />
          <button type="submit" className="agentUserRequestButton" disabled={isSubmitting}>Send</button>
        </form>
      )}
      {submitError ? <div className="agentUserRequestError" role="alert">{submitError}</div> : null}
    </div>
  );
}
