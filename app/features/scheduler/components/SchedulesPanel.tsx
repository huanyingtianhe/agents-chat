'use client';

import { useRef, useState } from 'react';
import type { CronJob, ScheduleSpec } from '../scheduleTypes';
import { useSchedules } from '../hooks/useSchedules';
import { ScheduleEditor } from './ScheduleEditor';
import { RunHistory } from './RunHistory';

export interface SchedulesPanelProps {
  agents: Array<{ id: string; name: string }>;
  isOpen: boolean;
  onClose: () => void;
  mobileModal?: boolean;
  mobileRestricted?: boolean;
}

function summarizeSpec(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'every_minutes':
      return `Every ${spec.interval} min`;
    case 'every_hours':
      return `Every ${spec.interval} h`;
    case 'every_days':
      return `Every ${spec.interval} d @ ${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`;
    case 'daily':
      return `Daily ${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`;
    case 'weekly': {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const dayStr = spec.weekdays
        .sort((a, b) => a - b)
        .map((d) => days[d])
        .join(',');
      return `${dayStr} ${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}`;
    }
  }
}

export function SchedulesPanel({ agents, isOpen, onClose, mobileModal = false, mobileRestricted = false }: SchedulesPanelProps) {
  const { jobs, loading, error, refresh, update } = useSchedules(isOpen);
  const [editingJobId, setEditingJobId] = useState<string | null | 'new'>(null);
  const [viewingRunsJobId, setViewingRunsJobId] = useState<string | null>(null);
  const [updatingJobId, setUpdatingJobId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const updateInFlightRef = useRef(false);

  const handleSaved = async () => {
    setEditingJobId(null);
    await refresh();
  };

  async function toggleEnabled(job: CronJob) {
    if (updateInFlightRef.current) return;
    updateInFlightRef.current = true;
    setUpdatingJobId(job.id);
    setActionError(null);
    try {
      await update(job.id, { enabled: !job.enabled });
    } catch (toggleError) {
      setActionError(toggleError instanceof Error ? toggleError.message : String(toggleError));
    } finally {
      updateInFlightRef.current = false;
      setUpdatingJobId(null);
    }
  }

  async function retry() {
    setActionError(null);
    await refresh();
  }

  if (!isOpen) return null;

  return (
    <>
      <aside
        className={`agentsSidebar ${isOpen ? 'mobilePanelVisible' : ''}`}
        data-mobile-overlay-surface="schedules"
        tabIndex={-1}
        role={mobileModal ? 'dialog' : undefined}
        aria-modal={mobileModal || undefined}
        aria-label={mobileModal ? 'Schedules' : undefined}
        aria-hidden={viewingRunsJobId !== null || editingJobId !== null || undefined}
        inert={viewingRunsJobId !== null || editingJobId !== null || undefined}
      >
        <div className="agentsSidebarHeader">
          <span>Schedules</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            {!mobileRestricted && (
              <button
                className="sidebarToggle"
                onClick={() => setEditingJobId('new')}
                title="Create schedule"
              >
                +
              </button>
            )}
            <button className="sidebarToggle" onClick={onClose} aria-label="Close schedules" data-mobile-overlay-initial-focus>
              →
            </button>
          </div>
        </div>
        {error || actionError ? (
          <div className="panelError" role="alert">
            <span>{actionError || error}</span>
            <button type="button" onClick={() => void retry()}>Retry</button>
          </div>
        ) : null}
        <div className="agentsSidebarSection">
          {jobs.map((job) => (
            <div
              key={job.id}
              className="agentListItem scheduleListItem"
              style={{ justifyContent: 'space-between', alignItems: 'center', padding: 0 }}
            >
              <button
                type="button"
                className="scheduleListMain"
                onClick={() => {
                  if (!mobileRestricted) setEditingJobId(job.id);
                }}
                disabled={mobileRestricted}
                title={mobileRestricted ? undefined : `${job.name} — Click to edit`}
              >
                <span className="agentListAvatar">{(job.name || job.id).slice(0, 1).toUpperCase()}</span>
                <span className="agentListInfo">
                  <span className="agentListName">{job.name}</span>
                  <span className="agentListId">{summarizeSpec(job.scheduleSpec)}</span>
                  <span className="scheduleStatusText">{job.enabled ? 'Enabled' : 'Disabled'}</span>
                  <span className="scheduleLastRun">
                    {job.lastRunAt ? `Last run: ${new Date(job.lastRunAt).toLocaleString()}` : 'Never run'}
                  </span>
                </span>
              </button>
              <button
                type="button"
                className={`scheduleSwitch ${job.enabled ? 'enabled' : ''}`}
                role="switch"
                aria-checked={job.enabled}
                aria-label={`${job.enabled ? 'Disable' : 'Enable'} ${job.name}`}
                disabled={updatingJobId !== null}
                onClick={() => void toggleEnabled(job)}
              >
                <span className="scheduleSwitchThumb" aria-hidden="true" />
              </button>
              <button
                type="button"
                className="sidebarToggle"
                onClick={() => setViewingRunsJobId(job.id)}
                title="View run history"
                style={{ marginLeft: '4px', flexShrink: 0 }}
              >
                📜
              </button>
            </div>
          ))}
          {jobs.length === 0 && (
            <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
              {loading ? 'Loading...' : 'No schedules configured'}
            </div>
          )}
        </div>
        {mobileRestricted ? <p className="mobileDesktopHint panelDesktopHint">Use the desktop interface to create or edit schedules.</p> : null}
      </aside>

      {!mobileRestricted && editingJobId !== null && (
        <ScheduleEditor
          jobId={editingJobId}
          agents={agents}
          onClose={() => setEditingJobId(null)}
          onSaved={handleSaved}
        />
      )}

      {viewingRunsJobId !== null && (
        <RunHistory jobId={viewingRunsJobId} onClose={() => setViewingRunsJobId(null)} />
      )}
    </>
  );
}
