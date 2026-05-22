'use client';

import { useEffect, useState } from 'react';
import type { CronJob, CronRun } from '../scheduleTypes';
import { useSchedules } from '../hooks/useSchedules';

export interface RunHistoryProps {
  jobId: string;
  onClose: () => void;
}

export function RunHistory({ jobId, onClose }: RunHistoryProps) {
  const { loadDetail, runNow } = useSchedules();

  const [job, setJob] = useState<CronJob | null>(null);
  const [runs, setRuns] = useState<CronRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const { job: j, runs: r } = await loadDetail(jobId);
      setJob(j);
      setRuns(r.slice(0, 20)); // Last 20
      setError(null);
    } catch (e: any) {
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

  if (loading) {
    return (
      <div className="modalOverlay">
        <div className="modal agentSettingsModal">
          <div style={{ textAlign: 'center', padding: '20px', color: '#8a90a2' }}>Loading...</div>
        </div>
      </div>
    );
  }

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
    <div className="modalOverlay">
      <div className="modal agentSettingsModal">
        <h2>📜 {job?.name || jobId} — Runs</h2>

        {error && (
          <div style={{ padding: '10px', backgroundColor: '#3d2d2d', color: '#ff9999', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
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

        <div className="modalActions">
          <button className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
