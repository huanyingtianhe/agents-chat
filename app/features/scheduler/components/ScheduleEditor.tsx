'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CronJob, ScheduleSpec } from '../scheduleTypes';
import { validateSpec, nextFires } from '../scheduleSpec';
import { useSchedules } from '../hooks/useSchedules';

export interface ScheduleEditorProps {
  jobId: string | 'new';
  agents: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSaved: () => void;
}

export function ScheduleEditor({ jobId, agents, onClose, onSaved }: ScheduleEditorProps) {
  const { loadDetail, create, update, remove } = useSchedules();

  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [specKind, setSpecKind] = useState<ScheduleSpec['kind']>('every_minutes');

  // Dynamic fields based on kind
  const [everyMinutesInterval, setEveryMinutesInterval] = useState(30);
  const [everyHoursInterval, setEveryHoursInterval] = useState(1);
  const [everyDaysInterval, setEveryDaysInterval] = useState(1);
  const [dailyHour, setDailyHour] = useState(9);
  const [dailyMinute, setDailyMinute] = useState(0);
  const [weekdaysSelected, setWeekdaysSelected] = useState<boolean[]>([false, false, false, false, false, false, false]);
  const [weeklyHour, setWeeklyHour] = useState(9);
  const [weeklyMinute, setWeeklyMinute] = useState(0);

  // Load existing job on mount
  useEffect(() => {
    if (jobId === 'new') {
      setName('');
      setAgentId(agents[0]?.id || '');
      setPrompt('');
      setEnabled(true);
      setSpecKind('every_minutes');
      setEveryMinutesInterval(60);
      setError(null);
    } else {
      setLoading(true);
      loadDetail(jobId)
        .then(({ job }) => {
          setName(job.name);
          setAgentId(job.agentId);
          setPrompt(job.prompt);
          setEnabled(job.enabled);
          setError(null);
          populateFromSpec(job.scheduleSpec);
        })
        .catch((e) => {
          setError(String(e?.message ?? e));
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [jobId, agents, loadDetail]);

  function populateFromSpec(spec: ScheduleSpec) {
    setSpecKind(spec.kind);
    switch (spec.kind) {
      case 'every_minutes':
        setEveryMinutesInterval(spec.interval);
        break;
      case 'every_hours':
        setEveryHoursInterval(spec.interval);
        break;
      case 'every_days':
        setEveryDaysInterval(spec.interval);
        setDailyHour(spec.hour);
        setDailyMinute(spec.minute);
        break;
      case 'daily':
        setDailyHour(spec.hour);
        setDailyMinute(spec.minute);
        break;
      case 'weekly':
        setWeeklyHour(spec.hour);
        setWeeklyMinute(spec.minute);
        const selected = [false, false, false, false, false, false, false];
        spec.weekdays.forEach((d) => {
          selected[d] = true;
        });
        setWeekdaysSelected(selected);
        break;
    }
  }

  function buildSpec(): ScheduleSpec {
    switch (specKind) {
      case 'every_minutes':
        return { kind: 'every_minutes', interval: everyMinutesInterval };
      case 'every_hours':
        return { kind: 'every_hours', interval: everyHoursInterval };
      case 'every_days':
        return { kind: 'every_days', interval: everyDaysInterval, hour: dailyHour, minute: dailyMinute };
      case 'daily':
        return { kind: 'daily', hour: dailyHour, minute: dailyMinute };
      case 'weekly':
        const weekdays = weekdaysSelected
          .map((selected, index) => (selected ? (index as 0 | 1 | 2 | 3 | 4 | 5 | 6) : null))
          .filter((d) => d !== null) as Array<0 | 1 | 2 | 3 | 4 | 5 | 6>;
        return { kind: 'weekly', weekdays, hour: weeklyHour, minute: weeklyMinute };
    }
  }

  const spec = buildSpec();

  const validationError = useMemo(() => {
    try {
      validateSpec(spec);
      return null;
    } catch (e: any) {
      return String(e?.message ?? e);
    }
  }, [spec]);

  const nextFireDates = useMemo(() => {
    if (validationError) return [];
    try {
      return nextFires(spec, 3, Date.now());
    } catch (e) {
      return [];
    }
  }, [spec, validationError]);

  const isFormValid = !validationError && name.trim() && agentId && prompt.trim();

  const handleSave = async () => {
    if (!isFormValid) return;
    setSaving(true);
    try {
      if (jobId === 'new') {
        await create({
          agentId,
          name,
          prompt,
          scheduleSpec: spec,
          enabled,
        });
      } else {
        await update(jobId, {
          name,
          prompt,
          scheduleSpec: spec,
          enabled,
        });
      }
      onSaved();
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (jobId === 'new') return;
    if (!confirm(`Delete schedule "${name}"?`)) return;
    setSaving(true);
    try {
      await remove(jobId);
      onSaved();
      onClose();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setSaving(false);
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

  return (
    <div className="modalOverlay">
      <div className="modal agentSettingsModal">
        <h2>{jobId === 'new' ? '⏱️ Create Schedule' : '⏱️ Edit Schedule'}</h2>

        {error && (
          <div style={{ padding: '10px', backgroundColor: '#3d2d2d', color: '#ff9999', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
            {error}
          </div>
        )}

        <label>
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="E.g., Daily report generation"
            disabled={saving}
          />
        </label>

        <label>
          <span>Agent</span>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={jobId !== 'new' || saving}
            style={{ opacity: jobId !== 'new' ? 0.6 : 1 }}
          >
            <option value="">— Select an agent —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.id})
              </option>
            ))}
          </select>
          {jobId !== 'new' && <span className="fieldHint">Agent cannot be changed after creation</span>}
        </label>

        <label>
          <span>Prompt</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should the agent do?"
            rows={4}
            disabled={saving}
          />
        </label>

        <label>
          <span>Schedule Type</span>
          <select value={specKind} onChange={(e) => setSpecKind(e.target.value as ScheduleSpec['kind'])} disabled={saving}>
            <option value="every_minutes">Every N minutes</option>
            <option value="every_hours">Every N hours</option>
            <option value="every_days">Every N days at time</option>
            <option value="daily">Daily at time</option>
            <option value="weekly">Weekly on days at time</option>
          </select>
        </label>

        {specKind === 'every_minutes' && (
          <label>
            <span>Every N minutes</span>
            <input
              type="number"
              value={everyMinutesInterval}
              onChange={(e) => setEveryMinutesInterval(Math.max(1, Math.min(59, parseInt(e.target.value) || 1)))}
              min="1"
              max="59"
              disabled={saving}
            />
          </label>
        )}

        {specKind === 'every_hours' && (
          <label>
            <span>Every N hours</span>
            <input
              type="number"
              value={everyHoursInterval}
              onChange={(e) => setEveryHoursInterval(Math.max(1, Math.min(23, parseInt(e.target.value) || 1)))}
              min="1"
              max="23"
              disabled={saving}
            />
          </label>
        )}

        {specKind === 'every_days' && (
          <>
            <label>
              <span>Every N days</span>
              <input
                type="number"
                value={everyDaysInterval}
                onChange={(e) => setEveryDaysInterval(Math.max(1, Math.min(30, parseInt(e.target.value) || 1)))}
                min="1"
                max="30"
                disabled={saving}
              />
            </label>
            <div style={{ display: 'flex', gap: '12px' }}>
              <label style={{ flex: 1 }}>
                <span>Hour (0-23)</span>
                <input
                  type="number"
                  value={dailyHour}
                  onChange={(e) => setDailyHour(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
                  min="0"
                  max="23"
                  disabled={saving}
                />
              </label>
              <label style={{ flex: 1 }}>
                <span>Minute (0-59)</span>
                <input
                  type="number"
                  value={dailyMinute}
                  onChange={(e) => setDailyMinute(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                  min="0"
                  max="59"
                  disabled={saving}
                />
              </label>
            </div>
          </>
        )}

        {specKind === 'daily' && (
          <div style={{ display: 'flex', gap: '12px' }}>
            <label style={{ flex: 1 }}>
              <span>Hour (0-23)</span>
              <input
                type="number"
                value={dailyHour}
                onChange={(e) => setDailyHour(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
                min="0"
                max="23"
                disabled={saving}
              />
            </label>
            <label style={{ flex: 1 }}>
              <span>Minute (0-59)</span>
              <input
                type="number"
                value={dailyMinute}
                onChange={(e) => setDailyMinute(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                min="0"
                max="59"
                disabled={saving}
              />
            </label>
          </div>
        )}

        {specKind === 'weekly' && (
          <>
            <label>
              <span>Days of week</span>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, idx) => (
                  <label key={idx} className="checkboxLabel" style={{ margin: 0, flex: 0 }}>
                    <input
                      type="checkbox"
                      checked={weekdaysSelected[idx]}
                      onChange={(e) => {
                        const newSelected = [...weekdaysSelected];
                        newSelected[idx] = e.target.checked;
                        setWeekdaysSelected(newSelected);
                      }}
                      disabled={saving}
                    />
                    <span>{day}</span>
                  </label>
                ))}
              </div>
            </label>
            <div style={{ display: 'flex', gap: '12px' }}>
              <label style={{ flex: 1 }}>
                <span>Hour (0-23)</span>
                <input
                  type="number"
                  value={weeklyHour}
                  onChange={(e) => setWeeklyHour(Math.max(0, Math.min(23, parseInt(e.target.value) || 0)))}
                  min="0"
                  max="23"
                  disabled={saving}
                />
              </label>
              <label style={{ flex: 1 }}>
                <span>Minute (0-59)</span>
                <input
                  type="number"
                  value={weeklyMinute}
                  onChange={(e) => setWeeklyMinute(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                  min="0"
                  max="59"
                  disabled={saving}
                />
              </label>
            </div>
          </>
        )}

        <label className="checkboxLabel">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={saving} />
          <span>Enabled</span>
        </label>

        {validationError && (
          <div style={{ padding: '10px', backgroundColor: '#3d2d2d', color: '#ff9999', borderRadius: '8px', marginBottom: '16px', fontSize: '13px' }}>
            {validationError}
          </div>
        )}

        {nextFireDates.length > 0 && !validationError && (
          <div style={{ padding: '10px', backgroundColor: 'rgba(99,179,237,0.1)', borderRadius: '8px', marginBottom: '16px', fontSize: '12px' }}>
            <div style={{ color: '#63b3ed', marginBottom: '4px', fontWeight: 600 }}>Next fires:</div>
            {nextFireDates.map((ts, idx) => (
              <div key={idx} style={{ color: '#a0aec0' }}>
                {new Date(ts).toLocaleString()}
              </div>
            ))}
          </div>
        )}

        <div className="modalActions">
          <button
            className="primary"
            onClick={handleSave}
            disabled={!isFormValid || saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          <button className="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          {jobId !== 'new' && (
            <button className="danger" onClick={handleDelete} disabled={saving} style={{ marginLeft: 'auto' }}>
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
