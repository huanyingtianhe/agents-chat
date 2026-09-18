'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CronJob, CronRun } from '../scheduleTypes';
import { useSchedules } from '../hooks/useSchedules';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'details > summary',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function visibleFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[inert], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0;
  });
}

export interface RunHistoryProps {
  jobId: string;
  opener: HTMLElement | null;
  onClose: () => void;
}

export function RunHistory({ jobId, opener, onClose }: RunHistoryProps) {
  const { loadDetail, runNow } = useSchedules(false);

  const [job, setJob] = useState<CronJob | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedSuccessfully, setLoadedSuccessfully] = useState(false);
  const [running, setRunning] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closedRef = useRef(false);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    onClose();
    window.requestAnimationFrame(() => opener?.isConnected && opener.focus());
  }, [onClose, opener]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => dialogRef.current?.focus());
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (event.key !== 'Tab') return;

      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = visibleFocusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey ? active === first || !dialog.contains(active) : active === last || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    const containFocus = (event: FocusEvent) => {
      const dialog = dialogRef.current;
      if (!dialog || dialog.contains(event.target as Node)) return;
      (visibleFocusableElements(dialog)[0] ?? dialog).focus();
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    window.addEventListener('focusin', containFocus, { capture: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
      window.removeEventListener('focusin', containFocus, { capture: true });
    };
  }, [close]);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);
      setLoadedSuccessfully(false);
      const { job: j, runs: r } = await loadDetail(jobId);
      setJob(j);
      setRuns(r.slice(0, 20)); // Last 20
      setError(null);
      setLoadedSuccessfully(true);
    } catch (e: any) {
      setJob(null);
      setRuns([]);
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [jobId, loadDetail]);

  const handleRunNow = async () => {
    if (!job) return;
    setRunning(true);
    try {
      await runNow(jobId);
      await loadData();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  };

  const statusIcon = (status: CronRun['status']) => {
    switch (status) {
      case 'success':
        return '✅';
      case 'error':
        return '❌';
      case 'running':
        return '⏳';
      case 'skipped':
        return '⊘';
      case 'queued':
        return '⏱';
    }
  };

  return (
    <div
      className="modalOverlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="modal agentSettingsModal"
        role="dialog"
        aria-modal="true"
        aria-label={`${job?.name || jobId} runs`}
        tabIndex={-1}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: '20px', color: '#8a90a2' }}>Loading...</div>
        ) : (
          <>
            <h2>📜 {job?.name || jobId} — Runs</h2>

            {error && !loadedSuccessfully ? (
              <div role="alert" style={{ padding: '10px', backgroundColor: '#3d2d2d', color: '#ff9999', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
                <div>{error}</div>
                <button type="button" className="secondary" onClick={() => void loadData()} style={{ marginTop: '10px' }}>
                  Retry
                </button>
              </div>
            ) : loadedSuccessfully ? (
              <>
                {error && (
                  <div role="alert" style={{ padding: '10px', backgroundColor: '#3d2d2d', color: '#ff9999', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
                    {error}
                  </div>
                )}
                <div style={{ marginBottom: '16px' }}>
                  <button className="primary inlinePrimary" onClick={handleRunNow} disabled={running || !job}>
                    {running ? 'Running...' : '▶ Run now'}
                  </button>
                </div>

                {runs.length === 0 ? (
                  <div style={{ padding: '20px', textAlign: 'center', color: '#8a90a2', fontSize: '13px' }}>
                    No runs yet
                  </div>
                ) : (
                  <div style={{ maxHeight: '400px', overflowY: 'auto', fontSize: '12px' }}>
                    {runs.map((run) => (
                      <details key={run.id} style={{ marginBottom: '8px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }}>
                        <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', userSelect: 'none' }}>
                          <span>{statusIcon(run.status)}</span>
                          <span style={{ color: '#a0aec0', flex: 1 }}>
                            {new Date(run.scheduledFor).toLocaleString()}
                          </span>
                          {run.startedAt && run.finishedAt && (
                            <span style={{ color: '#8a90a2', marginLeft: 'auto' }}>
                              {((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s
                            </span>
                          )}
                          {(!run.startedAt || !run.finishedAt) && (
                            <span style={{ color: '#8a90a2', marginLeft: 'auto' }}>—</span>
                          )}
                        </summary>
                        <div style={{ paddingLeft: '24px', color: '#8a90a2', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {run.status === 'success' && run.replyText && (
                            <div>
                              <strong style={{ color: '#a0aec0' }}>Reply:</strong>
                              <div style={{ marginTop: '4px' }}>{run.replyText}</div>
                            </div>
                          )}
                          {run.status === 'error' && run.errorMessage && (
                            <div style={{ color: '#ff9999' }}>
                              <strong>Error:</strong>
                              <div style={{ marginTop: '4px' }}>{run.errorMessage}</div>
                            </div>
                          )}
                          {run.status === 'skipped' && <div>Skipped (job disabled or missing agent)</div>}
                          {run.status === 'queued' && <div>Queued for execution</div>}
                          {run.status === 'running' && <div>Currently running...</div>}
                        </div>
                      </details>
                    ))}
                  </div>
                )}
              </>
            ) : null}

            <div className="modalActions">
              <button className="secondary" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
