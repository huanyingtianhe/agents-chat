# Chat bottom reading anchor across viewport changes

## Acceptance and integration update (2026-09-20)

The approved candidate `013844da241291cab4de5ff4d4dd115f45cde4e7` was deployed
with separate authorization as build `LvyqwH4tHliNBhFm3ygAy`. The user reported
that physical-device testing passed and requested adding the changes to
`huanyingtianhe/agents-chat#50`. This supersedes the original separate-branch/
typography-only PR integration boundary below, not the native-zoom exclusions.

## Scope and baseline

Preserve the user's reading position throughout portrait -> landscape -> portrait
transitions, including positions inside long Markdown messages. This is separate
from the typography fix and the documented iPhone Chrome native-zoom limitation.

Start from `f6b15e52e36170359496fc4fd3e386ab318c0cff` on the isolated
`fix/rotation-reading-anchor` branch. Its source tree equals the deployed
`c65dd6250c2ef416fb3771b92bda92e3993d2da1` artifact. Do not modify the
typography-only PR or the archived investigation branch.

The user explicitly selected the bottom of the visible chat as the reading
anchor: it is adjacent to the composer and remains the natural focus when the
landscape viewport exposes less content.

## Observed application-level defects

- `ChatPageClient.tsx:218` follows the bottom when `messages` changes, not when
  the chat viewport or wrapping changes.
- `ChatPageClient.tsx:240-246` infers user departure from a decreasing
  `scrollTop`. Layout-induced clamping can also decrease that value.
- `ChatShell.tsx:54-66` updates viewport geometry on resize/orientation events.
  This does not notify the current chat-scroll policy.
- `ChatShell.css:284-288` explicitly disables native scroll anchoring.
- Existing typography rotation tests compare font metrics, not reading
  position. Existing mobile layout tests do not cover bottom anchoring across
  an orientation round trip.

These are source-level findings explaining the reported failure. Establish
remote failing regressions before claiming the fix has reproduced and resolved
the symptom.

## Required behavior

### Following the latest messages

If the user is following the bottom before a layout change, maintain the bottom
through every subsequent geometry change. A viewport-induced scroll event must
not turn this into history-reading mode. Preserve the existing four-CSS-pixel
near-bottom threshold.

The "Jump to latest messages" action explicitly enters bottom-follow mode.
Loading a different chat retains its existing initial-bottom behavior.

### Reading historical content

Anchor the lowest fully visible suitable body-text position in the chat
viewport, including a character position inside a long paragraph. Record its
distance from the chat viewport's bottom edge. After reflow, restore that same
text position to the same bottom-relative distance.

The reference edge belongs to `.chatContainer`, immediately above the composer,
not the document, screen, keyboard, or browser toolbar. Message-copy buttons,
collapse controls, floating toasts and the jump button are not text anchors.
Normal padding/gaps remain part of the measured distance.

Do not use only a message index, message top, old `scrollTop`, or scroll
percentage. These cannot preserve a position inside a long rewrapped message.

Use stable message identity plus a logical text position to survive React
reconciliation. A DOM node or Range may accelerate restoration, but must not be
the only identity when streaming replaces rendered nodes. Code and table body
text remain eligible. For an image or other non-text body region with no
suitable visible text, use the element and the relative visible position within
it rather than jumping to unrelated text or the message's beginning.

Restore to the nearest reachable scroll position if the target is outside the
scrollable range. If the chat fits entirely in the viewport, leave it unscrolled.
If the viewport contains only a fragment of a text line, use that visible line
instead of requiring an unavailable fully visible line.

### User intent and content changes

- User scrolling in landscape establishes a new anchor. Returning to portrait
  must not restore the stale portrait anchor.
- Layout-driven and controller-written scroll events must not replace the
  saved anchor or be mistaken for user intent, including events delivered before
  the resize observer callback.
- Streaming/new content below a historical anchor must not pull the reader down.
  Bottom-follow mode continues to follow streaming content.
- Explicit expand/collapse or removal can invalidate an anchor. Preserve a
  surviving nearby position in the same content where possible, clamp to the
  available range, then establish a new visible anchor. Do not silently switch
  to following latest.
- Preserve the existing chat/file-tab restoration behavior. Hidden, unmounted,
  loading, or replaced chat containers cannot restore stale geometry into a
  different chat. Reattach observers when the actual scrolling element changes.
- Native touch scrolling, wheel/keyboard navigation, and momentum scrolling
  remain usable. Real user input takes precedence over a queued correction.
- Do not force scroll corrections during an active multi-touch gesture.
  Re-establish the anchor from the resulting view after that gesture, without
  changing the user's native zoom.

## Architecture

Extract the existing chat-scroll responsibility into a focused hook under
`app/features/chat/runtime/`. It owns follow/reading state, scroll handling,
queued layout corrections, jump-to-latest state, and integration with existing
chat selection and file-tab restoration.

Keep geometry/anchor operations in a focused chat helper. Expose explicit typed
anchor and measurement shapes; avoid app-wide event buses or new dependencies.
Add stable DOM message identity at the message-rendering boundary where needed.
Do not add scrolling algorithms to `ChatPageClient`; it remains a composition
layer.

Observe the real chat viewport and its rendered content geometry. Handle
changes in both wrapping and available height, rather than relying on one
`orientationchange` callback or a fixed delay. Retain the pre-change anchor
through multi-stage browser layout updates. Coalesce work per animation frame,
and only write `scrollTop` when correction is necessary. Do not use an unbounded
frame loop, timer-based retries, or DOM-wide character scanning on every scroll.

Keep `overflow-anchor: none` while the application owns the reading anchor, so
browser and application corrections do not compete.

## Alternatives rejected

1. Unconditionally scroll to the bottom on rotation: breaks history reading.
2. Preserve `scrollTop` or a scroll percentage: changes which words are visible
   after rewrapping, especially inside long messages.
3. Enable browser CSS anchoring alone: does not specify a bottom text anchor or
   resolve current application stickiness classification across browsers.

## Remote validation and acceptance

Use existing synthetic-chat/login fixtures and GitHub Actions. No local
dependency installation, builds, type-checks, or browser/unit-test runs.
Do not use real production conversations for fixtures.

Add focused logic tests where operations are pure, plus Playwright coverage in
desktop Chromium, Android Chromium and iPhone WebKit projects. Ensure the new
spec is selected by both the relevant project configuration and CI commands.

First capture a failing regression against the unchanged runtime. Then verify:

- Several portrait/landscape round trips in both initial orientations. At
  latest, settled distance to bottom remains at most four CSS pixels.
- Historical content across separate messages and a paragraph taller than a
  viewport. The same logical text anchor remains visible and its bottom-edge
  distance differs by at most two CSS pixels after each settled transition,
  except when clamped to a documented scroll boundary.
- Non-text anchoring, code/table text, content shorter than the viewport, and
  multiple resize steps before geometry settles.
- User scrolling between rotations updates the expected anchor rather than
  restoring the initial view.
- Streaming while following latest and while reading history; delayed content
  growth must not invalidate the saved reading point.
- Jump-to-latest, chat switching/loading, file-tab restoration, and viewport
  height changes caused by the composer retain their intended behavior.
- Existing typography/viewport policies, drafts and attachments remain intact.

Assert semantic anchor identity and bottom-relative geometry, not merely equal
scroll offsets, visibility of a message somewhere, or screenshots that look
similar. Record geometry and traces on failure to distinguish reflow, clamping,
user input, and application corrections.

Playwright WebKit is a regression environment, not proof of physical iPhone
Chrome behavior. Real-device confirmation follows separately after a green
candidate and user-authorized deployment.

## Non-goals and release boundary

No native page zoom reset, viewport-meta writes, scale compensation, history
manipulation, reload, diagnostic UI, new backend API, or changes to font sizes.
Do not revive previous viewport recovery experiments.

Implementation and remote validation do not authorize deployment. Keep the
currently running production build unchanged until the user approves deploying
this new scroll-fix candidate.
