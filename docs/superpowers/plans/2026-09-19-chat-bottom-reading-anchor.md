# Chat Bottom Reading Anchor Implementation Plan

> **For agentic workers:** Execute this plan inline, task-by-task. The user prohibits subagents and local tests/builds/installations; use GitHub Actions for execution and verification.

**Goal:** Keep the same bottom-visible reading position through reflow, while retaining bottom-follow and native user scrolling.

**Architecture:** A DOM anchor helper identifies a logical text/element point; a scroll controller retains that point across geometry changes and separates user input from automatic scroll events. A focused React hook wires the controller into chat selection and file-tab restoration, leaving the page as composition.

**Tech Stack:** TypeScript, DOM Range/ResizeObserver/MutationObserver, React 19, Node built-in test runner, Playwright, existing GitHub Actions.

---

## Files and responsibilities

- Create `tests/chat-reading-anchor.spec.ts`: semantic bottom-anchor regression, independent browser measurements and synthetic chats.
- Create `tests/chat-scroll-geometry.test.mjs`: pure geometry/state arithmetic.
- Modify `tests/playwright.config.ts`: select the new browser spec in all three projects.
- Modify `.github/workflows/markdown-typography.yml`: dispatchable remote red/green validation, retain production-origin artifact preparation and existing regression steps.
- Create `app/features/chat/chatScrollGeometry.ts`: pure clamping, bottom-distance and geometry-change calculations.
- Create `app/features/chat/chatReadingAnchor.ts`: capture/resolve logical text and non-text reading positions; no React or timers.
- Create `app/features/chat/runtime/chatScrollController.ts`: one mounted container's state, observers, input events and cleanup.
- Create `app/features/chat/runtime/useChatScroll.ts`: DOM attachment, jump UI state, per-chat file-tab snapshots and chat-load entry points.
- Modify `app/features/chat/ChatPageClient.tsx`: replace the inline scroll responsibility with the hook; retain existing loading/focus behavior.
- Modify `app/features/messages/components/MessageBubble.tsx`: expose stable `data-message-id`.
- Modify `app/features/layout/components/ChatShell.css`: a measurable content wrapper with the same flex-column spacing.
- Update the approved spec only if evidence requires an explicit correction; document run results here.

## Task 1: Establish the failing regression remotely

- [ ] Add synthetic long Markdown to the existing mobile fixture. Override only chat-list/detail responses; use `installMobileChatFixture` and `loginMobileFixture` for authentication and unrelated APIs. Keep exactly one user message so the existing login readiness locator remains strict.
- [ ] Add an initial-bottom round trip using actual `page.setViewportSize` changes, not only synthetic orientation events:

```ts
await page.setViewportSize({ width: 390, height: 844 });
await loginMobileFixture(page);
const chat = page.locator('.chatContainer');
await chat.evaluate((element) => { element.scrollTop = element.scrollHeight; });
for (const size of [
  { width: 844, height: 390 },
  { width: 390, height: 844 },
]) {
  await page.setViewportSize(size);
  await expect.poll(() => chat.evaluate((element) =>
    element.scrollHeight - element.clientHeight - element.scrollTop,
  )).toBeLessThanOrEqual(4);
}
```

- [ ] Add historical long-paragraph anchoring. Move into the paragraph, independently locate its lowest fully visible text character using DOM Range rectangles, and store the text offset and `chatBottom - characterBottom`. After each rotation resolve the same offset and assert distance error <= 2 CSS px. Ensure the paragraph is taller than a portrait viewport and the target is not clamped to the content boundary.
- [ ] Add the spec to mobile `testMatch` while leaving it enabled in desktop's default match.
- [ ] Add a targeted workflow step before typography checks:

```yaml
- name: Check chat reading position
  run: >-
    npx playwright test --config tests/playwright.config.ts
    --project=${{ matrix.project }} tests/chat-reading-anchor.spec.ts
    --workers=1 --timeout=60000 --global-timeout=480000
    --trace=retain-on-failure --reporter=line --output=artifacts/reading-anchor
```

- [ ] Commit and push the red tests without a CI-skip marker. Dispatch the existing workflow on this branch:

```bash
git push -u origin fix/rotation-reading-anchor
gh workflow run markdown-typography.yml --repo xujxu/agents-chat \
  --ref fix/rotation-reading-anchor \
  -f build_origin=https://agent.xujx.us.kg
gh run list --repo xujxu/agents-chat --branch fix/rotation-reading-anchor \
  --event workflow_dispatch --limit 3
```

- [ ] Inspect the exact failed run's logs/artifacts. Expected: build succeeds, then orientation bottom/semantic-anchor assertions fail against unchanged production runtime. Do not treat fixture/login/build failures as reproduction.

## Task 2: Pure geometry and semantic anchors

- [ ] Add Node tests before the geometry module. Cover negative scroll overshoot, bottom tolerance, target clamping, identity correction and changed width/height/content height.

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { clampScrollTop, correctedScrollTop, isNearBottom }
  from '../app/features/chat/chatScrollGeometry.ts';

test('restores the same bottom-relative character point', () => {
  assert.equal(correctedScrollTop(400, 1200, 700, 40, 2000), 940);
  assert.equal(correctedScrollTop(400, 500, 700, 40, 2000), 240);
});
test('clamps only to reachable scroll positions', () => {
  assert.equal(clampScrollTop(-40, 2000), 0);
  assert.equal(clampScrollTop(2300, 2000), 2000);
  assert.equal(isNearBottom(1597, 2400, 800), true);
  assert.equal(isNearBottom(1500, 2400, 800), false);
});
```

- [ ] Run these remotely with Node 24 before implementation to verify the missing-module failure. Add `node --test tests/chat-scroll-geometry.test.mjs` to the existing workflow; keep the browser regression runnable independently of the pure-test result.
- [ ] Implement the geometry formulas:

```ts
export function clampScrollTop(value: number, maximum: number): number {
  return Math.max(0, Math.min(value, Math.max(0, maximum)));
}
export function isNearBottom(top: number, height: number, viewport: number): boolean {
  return height - top - viewport <= 4;
}
export function correctedScrollTop(
  top: number, pointBottom: number, viewportBottom: number,
  bottomGap: number, maximum: number,
): number {
  return clampScrollTop(top + pointBottom - viewportBottom + bottomGap, maximum);
}
```

- [ ] Implement `captureReadingAnchor(container)` and `resolveReadingAnchor(container, anchor)` with a typed union:
  - Common identity: stable message ID and distance from the chat bottom.
  - Text: character offset among eligible message body text nodes, plus a direct-node fast path. Walk only eligible body content in intersecting messages; find the last visible character with binary search, not a page-wide character loop.
  - Element: stable position among eligible body images/non-text elements, and a fractional point inside the element.
  - Exclude UI controls, toasts and clipped/invisible text. Resolve by logical identity after a React node replacement. If an explicit removal/collapse invalidates a point, choose a surviving same-message boundary or establish a new visible anchor without switching to latest.
- [ ] Add `data-message-id={message.id}` to the existing message wrapper.

## Task 3: Controller and React integration

- [ ] Implement `createChatScrollController(container, onFollowChange, initialSnapshot?)`. Expose `snapshot()`, `jumpToLatest()`, `suspend()`, and `dispose()`.
- [ ] Keep one follow/history state, immutable saved anchor during layout, previous geometry, expected programmatic scroll target, pending frame, and short-lived user-input intent. Attach resize observation to the viewport and measurable content; observe child/text changes for replaced message nodes.
- [ ] On geometry/mutation notification schedule one correction frame. In follow mode set the clamped maximum. In history mode resolve the saved point and apply `correctedScrollTop`. Keep the original anchor across successive resize steps; do not recapture after each layout-driven correction.
- [ ] On scroll compare geometry before interpreting direction. A resize-induced or matching programmatic event must not cancel follow mode or overwrite the anchor. An ordinary scroll in unchanged geometry records current user position, as do explicit user-input events taking precedence over pending corrections.
- [ ] Handle wheel, single-touch movement, keyboard navigation and scrollbar dragging. Exclude editable controls and ignore horizontal-only wheel activity. Suspend corrections during multi-touch and rebase from the final user-selected view. Remove listeners, disconnect observers and cancel pending frames on disposal.
- [ ] Implement `useChatScroll(currentChatId)` to return the object ref used by existing focus code, an attachment callback, jump visibility/action, `handleBeforeFileTabChange`, and `prepareChatLoad`.
- [ ] Move file-tab snapshots into the hook, restoring only the matching chat. Initial mount/chat loading defaults to bottom; file-tab return uses the saved mode and anchor. Reattach the controller when the chat DOM node or chat identity changes.
- [ ] Replace page-local scroll refs/state/effects/handlers with those named hook outputs. Keep the existing chat-loading selection token and focus behavior. Do not leave the old `[messages]` scroll writer or unconditional post-load writer competing with the controller.
- [ ] Wrap message content and follow-up card in `.chatScrollContent`:

```css
.chatPageRoot .chatScrollContent {
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  min-width: 0;
  gap: inherit;
}
```

## Task 4: Green and coupled behavior

- [ ] Add repeated round trips, landscape-first, user scrolling in landscape, short content, non-text anchoring, code/table content, multi-stage resize, streaming below a historical anchor and jump-to-latest coverage.
- [ ] Exercise composer-height changes and existing chat/file restoration expectations. Use independent DOM measurements for semantic assertions; do not assert only that the implementation's own helper agrees with itself.
- [ ] Commit with the Copilot coauthor trailer, push and dispatch the same three-project workflow with the production origin. Run all geometry tests, the new browser spec, typography tests, and existing mobile/desktop regression selectors in Actions.
- [ ] Inspect failures and iterate on the exact cause. Keep failing traces and final geometry measurements. Do not weaken the agreed 2px/4px bounds to obtain a pass.
- [ ] Record exact green commit/run IDs here and leave PROD unchanged. Report any remaining device-only uncertainty explicitly; a new deployment requires separate approval.

## Execution and review

Execution is inline as already requested; do not ask to use subagents again.
No deployment is authorized by this plan.

Self-review: every agreed behavior maps to Tasks 2-4; the red run remains
separate from implementation; helper/controller/hook responsibilities are
bounded; test selection includes all three projects; native viewport, history,
font policy and backend code remain out of scope.

## Completion record (2026-09-20)

Implementation and remote validation are complete. The original task checkboxes
above describe the planned sequence; this record is the authoritative outcome.
The interrupted terminal session had not yet saved this final handoff.

- Validated code commit: `013844da241291cab4de5ff4d4dd115f45cde4e7`.
- Remote branch: `origin/fix/rotation-reading-anchor`.
- Green run: https://github.com/xujxu/agents-chat/actions/runs/35456686064.
- Red baseline: `62f4ad9`, run `35454668124`. All three builds succeeded;
  each browser failed all three original reading-position regressions.
  Initial rotation left the latest position 470 CSS pixels from the bottom.
- Final geometry tests: six passing cases in each of three jobs.
- Final browser results:

| Coverage | Desktop Chromium | Android Chromium | iPhone WebKit |
| --- | ---: | ---: | ---: |
| Reading-anchor E2E | 18 | 18 | 17 |
| Typography behavior | 8 | 7 | 7 |
| Served CSS/viewport policy | 1 | 1 | 1 |
| Existing coupled regressions | 17 | 31 | 31 |

Total: 157 browser passes plus 18 pure-test executions (175 passing executions).
Three intentional skips: two desktop-only typography cases in mobile projects,
and real mouse-wheel injection unsupported by Playwright mobile WebKit.
Keyboard and programmatic reading-position changes are covered in WebKit.
All three production builds and type checks passed. No local installation,
build, type check, unit test, or browser test was run.

The implementation retains a logical body-text/element point relative to the
chat viewport bottom, handles multi-stage reflow without overwriting that
anchor, and updates it on user scrolling. Follow-latest, smooth jump, streaming,
file return, composer resizing, long paragraphs, images, code and tables have
remote coverage. The existing WebKit navigation-position regression also passes
unchanged after distinguishing independent scrolling from intermediate reflow
clamping. Test fixtures wait for actual stable geometry, not a fixed delay.

The final desktop artifact is `10588408523`, build
`LvyqwH4tHliNBhFm3ygAy`. Read-only inspection confirmed the production origin,
25 routes without diagnostic endpoints, both root 100% text-adjust policies,
and the unrestricted ordinary viewport metadata.

PROD was not updated: it remains build `3tQ5Gip6b6QMwUDh4HZvF`, the previous
typography-only release. The typography PR was not changed and no scroll-fix PR
was opened. Physical iPhone confirmation is still pending a separately
authorized deployment; passing Playwright WebKit is not physical-device proof.
