'use client';

import { useEffect, useState } from 'react';
import type { CronJob, ScheduleSpec } from '../scheduleTypes';
import { ScheduleEditor } from './ScheduleEditor';
import { RunHistory } from './RunHistory';

export interface SchedulesPanelProps {
  agents: Array<{ id: string; name: string }>;
  isOpen: boolean;
  onClose: () => void;
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

export function SchedulesPanel({ agents, isOpen, onClose }: SchedulesPanelProps) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [editingJobId, setEditingJobId] = useState<string | null | 'new'>(null);
  const [viewingRunsJobId, setViewingRunsJobId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load jobs on mount or when panel opens
  useEffect(() => {
    if (!isOpen) return;
    const loadJobs = async () => {
      try {
        setLoading(true);
        const res = await fetch('/api/schedules');
        if (res.ok) {
          const data = await res.json();
          setJobs(data.jobs ?? []);
        }
      } finally {
        setLoading(false);
      }
    };
    loadJobs();
  }, [isOpen]);

  const handleSaved = () => {
    setEditingJobId(null);
    // Refresh jobs list
    const loadJobs = async () => {
      try {
        const res = await fetch('/api/schedules');
        if (res.ok) {
          const data = await res.json();
          setJobs(data.jobs ?? []);
        }
      } catch (e) {
        // ignore
      }
    };
    loadJobs();
  };

  if (!isOpen) return null;

  return (
    <>
      <aside className={`agentsSidebar ${isOpen ? 'mobilePanelVisible' : ''}`}>
        <div className="agentsSidebarHeader">
          <span>Schedules</span>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              className="sidebarToggle"
              onClick={() => setEditingJobId('new')}
              title="Create schedule"
            >
              +
            </button>
            <button className="sidebarToggle" onClick={onClose}>
              →
            </button>
          </div>
        </div>
        <div className="agentsSidebarSection">
          {jobs.map((job) => (
            <button
              key={job.id}
              className="agentListItem"
              onClick={() => setEditingJobId(job.id)}
              title={`${job.name} — Click to edit`}
              style={{ justifyContent: 'space-between', alignItems: 'center' }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="agentListAvatar">{(job.name || job.id).slice(0, 1).toUpperCase()}</span>
                <span className="agentListInfo">
                  <span className="agentListName">{job.name}</span>
                  <span className="agentListId">{summarizeSpec(job.scheduleSpec)}</span>
                </span>
              </span>
              <button
                className="sidebarToggle"
                onClick={(e) => {
                  e.stopPropagation();
                  setViewingRunsJobId(job.id);
                }}
                title="View run history"
                style={{ marginLeft: '8px', flexShrink: 0 }}
              >
                📜
              </button>
              <span className={`agentListStatus ${job.enabled ? 'running' : ''}`} style={{ marginLeft: '4px' }}>
                {job.enabled ? '●' : '○'}
              </span>
            </button>
          ))}
          {jobs.length === 0 && (
            <div className="muted" style={{ padding: 20, textAlign: 'center' }}>
              {loading ? 'Loading...' : 'No schedules configured'}
            </div>
          )}
        </div>
      </aside>

      {editingJobId !== null && (
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
