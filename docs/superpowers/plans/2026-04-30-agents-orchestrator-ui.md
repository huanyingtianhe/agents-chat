# Agents Orchestrator UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the existing orchestration modes (Pipeline / Discussion) in the chat UI via an @mention-triggered toggle, showing all agent responses plus a summary.

**Architecture:** The codebase already has full orchestration logic in `app/page.tsx:827-899` and @mention parsing at `page.tsx:306-329`. The state variable `orchestrationMode` exists at line 368 but is never exposed in the UI. This plan adds a mode toggle that appears when 2+ agents are @mentioned, wired to the existing state.

**Tech Stack:** React (Next.js), TypeScript, inline CSS-in-JSX (existing pattern)

**Spec:** `.omc/specs/deep-interview-agents-orchestrator-ui.md`

---

### Task 1: Add the Orchestration Mode Toggle UI

**Files:**
- Modify: `app/page.tsx:1513-1585` (inputArea section)
- Modify: `app/page.tsx:2330-2345` (CSS styles section)

This task adds a toggle bar between the target pills and the composer row that lets users switch between Pipeline and Discussion mode. It only appears when `orchestrationEnabled` is true (2+ agents @mentioned).

- [ ] **Step 1: Add the orchestration toggle markup**

Insert a mode toggle between the `targetPills` div and the `composerRow` div inside `composerShell`. The toggle should be conditionally rendered when `orchestrationEnabled` is true.

Find this block in `app/page.tsx` (around line 1514-1521):

```tsx
                <div className="composerShell">
                  {mentionedAgentIds.length > 0 ? (
                    <div className="targetPills">
                      {mentionedAgentIds.map((agentId) => (
                        <span key={agentId} className="targetPill">@{agentId}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="composerRow">
```

Replace with:

```tsx
                <div className="composerShell">
                  {mentionedAgentIds.length > 0 ? (
                    <div className="targetPills">
                      {mentionedAgentIds.map((agentId) => (
                        <span key={agentId} className="targetPill">@{agentId}</span>
                      ))}
                    </div>
                  ) : null}
                  {orchestrationEnabled && (
                    <div className="orchestrationToggle">
                      <button
                        type="button"
                        className={`orchToggleBtn ${orchestrationMode === 'pipeline' ? 'orchToggleActive' : ''}`}
                        onClick={() => setOrchestrationMode('pipeline')}
                        title="Pipeline: agents run sequentially, each receives the previous agent's output"
                      >
                        🔀 Pipeline
                      </button>
                      <button
                        type="button"
                        className={`orchToggleBtn ${orchestrationMode === 'discussion' ? 'orchToggleActive' : ''}`}
                        onClick={() => setOrchestrationMode('discussion')}
                        title="Discussion: agents run in parallel, then a summary is generated"
                      >
                        💬 Discussion
                      </button>
                    </div>
                  )}
                  <div className="composerRow">
```

- [ ] **Step 2: Add CSS styles for the toggle**

Find the `.composerShell` style block (around line 2333) and add the following styles after the `.composerShell:focus-within` block (after approximately line 2348):

```css
        .orchestrationToggle {
          display: flex;
          gap: 4px;
          padding: 2px;
          background: var(--panel-strong);
          border-radius: 12px;
          border: 1px solid var(--border);
        }
        .orchToggleBtn {
          flex: 1;
          padding: 4px 12px;
          border: none;
          border-radius: 10px;
          background: transparent;
          color: var(--muted);
          font-size: 0.82rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 160ms ease;
          white-space: nowrap;
        }
        .orchToggleBtn:hover {
          color: var(--fg);
          background: var(--accent-soft);
        }
        .orchToggleBtn.orchToggleActive {
          background: var(--accent);
          color: #fff;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        }
```

- [ ] **Step 3: Verify the toggle renders correctly**

Run the dev server:

```bash
npm run dev
```

Expected: When you type `@copilot @es-workload-ag` in the chat input, a toggle bar should appear showing "🔀 Pipeline" and "💬 Discussion" buttons. Clicking switches the active mode. When you remove one @mention so only one agent is targeted, the toggle should disappear.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add orchestration mode toggle UI for multi-agent @mentions

Shows Pipeline/Discussion toggle when 2+ agents are @mentioned.
Wired to existing orchestrationMode state.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Verify End-to-End Orchestration Flow

**Files:**
- No code changes — manual verification of existing orchestration logic

The orchestration logic already exists in `app/page.tsx:827-899` and the `handleSend` function at `904-953` already reads `orchestrationMode` state and dispatches accordingly. This task verifies the complete flow works end-to-end.

- [ ] **Step 1: Verify pipeline mode**

With the dev server running:
1. Type `@copilot @es-workload-ag what is 2+2?`
2. Select "🔀 Pipeline" mode
3. Press Enter

Expected:
- Copilot responds first
- Its response is automatically sent to es-workload-ag with pipeline context
- Both responses visible in chat
- A summary message appears at the end (labeled as summary)

- [ ] **Step 2: Verify discussion mode**

1. Type `@copilot @es-workload-ag what is the best programming language?`
2. Select "💬 Discussion" mode
3. Press Enter

Expected:
- Both agents respond in parallel with independent perspectives
- If discussionRounds > 1, agents respond to each other's perspectives in subsequent rounds
- A summary message appears at the end

- [ ] **Step 3: Verify single-agent fallback**

1. Type `@copilot hello`
2. Confirm the toggle does NOT appear (only 1 agent mentioned)
3. Press Enter

Expected: Normal single-agent response, no orchestration.

- [ ] **Step 4: Document any issues found**

If the existing orchestration logic has bugs or the summary is not rendering correctly, note the issues for a follow-up task. The current plan scope is exposing the toggle — the orchestration logic is pre-existing.

---

### Task 3: Add Discussion Rounds Control (Enhancement)

**Files:**
- Modify: `app/page.tsx:1513-1585` (inputArea section, inside the orchestrationToggle)
- Modify: `app/page.tsx` (CSS styles section)

The `discussionRounds` state already exists at line 369 and is used in the orchestration logic at line 919. This task exposes it in the UI when discussion mode is selected.

- [ ] **Step 1: Add rounds selector for discussion mode**

Find the orchestration toggle added in Task 1 and extend it. Replace the `orchestrationToggle` div we added:

```tsx
                  {orchestrationEnabled && (
                    <div className="orchestrationToggle">
                      <button
                        type="button"
                        className={`orchToggleBtn ${orchestrationMode === 'pipeline' ? 'orchToggleActive' : ''}`}
                        onClick={() => setOrchestrationMode('pipeline')}
                        title="Pipeline: agents run sequentially, each receives the previous agent's output"
                      >
                        🔀 Pipeline
                      </button>
                      <button
                        type="button"
                        className={`orchToggleBtn ${orchestrationMode === 'discussion' ? 'orchToggleActive' : ''}`}
                        onClick={() => setOrchestrationMode('discussion')}
                        title="Discussion: agents run in parallel, then a summary is generated"
                      >
                        💬 Discussion
                      </button>
                    </div>
                  )}
```

With:

```tsx
                  {orchestrationEnabled && (
                    <div className="orchestrationToggle">
                      <div className="orchModeBtns">
                        <button
                          type="button"
                          className={`orchToggleBtn ${orchestrationMode === 'pipeline' ? 'orchToggleActive' : ''}`}
                          onClick={() => setOrchestrationMode('pipeline')}
                          title="Pipeline: agents run sequentially, each receives the previous agent's output"
                        >
                          🔀 Pipeline
                        </button>
                        <button
                          type="button"
                          className={`orchToggleBtn ${orchestrationMode === 'discussion' ? 'orchToggleActive' : ''}`}
                          onClick={() => setOrchestrationMode('discussion')}
                          title="Discussion: agents run in parallel, then a summary is generated"
                        >
                          💬 Discussion
                        </button>
                      </div>
                      {orchestrationMode === 'discussion' && (
                        <div className="orchRoundsControl">
                          <label className="orchRoundsLabel">Rounds:</label>
                          <select
                            className="orchRoundsSelect"
                            value={discussionRounds}
                            onChange={(e) => setDiscussionRounds(Number(e.target.value))}
                          >
                            {[1, 2, 3, 4, 5].map((n) => (
                              <option key={n} value={n}>{n}</option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  )}
```

- [ ] **Step 2: Add CSS for the rounds control and update toggle layout**

Add after the existing `.orchToggleBtn.orchToggleActive` style:

```css
        .orchModeBtns {
          display: flex;
          gap: 4px;
          flex: 1;
        }
        .orchRoundsControl {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 8px;
          border-left: 1px solid var(--border);
        }
        .orchRoundsLabel {
          font-size: 0.78rem;
          color: var(--muted);
          font-weight: 600;
          white-space: nowrap;
        }
        .orchRoundsSelect {
          padding: 2px 6px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--panel-soft);
          color: var(--fg);
          font-size: 0.8rem;
          cursor: pointer;
        }
```

Also update the `.orchestrationToggle` style to accommodate the flex layout with the rounds control:

```css
        .orchestrationToggle {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 2px;
          background: var(--panel-strong);
          border-radius: 12px;
          border: 1px solid var(--border);
        }
```

- [ ] **Step 3: Verify the rounds selector**

Expected: When "💬 Discussion" mode is active, a "Rounds: [dropdown]" control appears next to the mode buttons. Selecting a different number changes `discussionRounds`. When switching to Pipeline mode, the rounds control disappears.

- [ ] **Step 4: Commit**

```bash
git add app/page.tsx
git commit -m "feat: add discussion rounds selector to orchestration toggle

Shows rounds dropdown (1-5) when Discussion mode is active.
Wired to existing discussionRounds state.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
