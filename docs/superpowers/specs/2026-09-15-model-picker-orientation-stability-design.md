# Model Picker and Mobile Orientation Stability Design

## Goal

Fix two responsive interaction defects without changing model persistence or
disabling user-controlled page zoom:

1. Opening the model picker in the Agents pane must not also open the Composer
   model picker.
2. Repeated portrait/landscape changes must not progressively enlarge the page.

## Current Behavior and Root Causes

### Duplicate model menus

The Agents pane and Composer both render `AgentModelSelect` for the same agent.
They share `openModelMenuAgentId`, whose identity contains only the agent ID.
When that value matches, both component instances consider themselves open and
each portals a dropdown into the page.

The selected model value is also shared, but that part is intentional: changing
the agent model in either surface should update the label and subsequent
requests everywhere.

### Orientation zoom

The root viewport allows user scaling and should continue to do so. However,
mobile Safari may automatically zoom focused form controls whose effective
font size is below 16px. The Composer is currently 15px and several mobile
forms use smaller sizes. Safari may retain that automatic scale while the
visual viewport changes orientation. The page also lacks an explicit
`text-size-adjust` policy, allowing orientation-related text inflation.

## Design

### Surface-scoped model menu identity

Keep one controlled menu state and one outside-click/Escape lifecycle, but make
the open identity include both the rendering surface and the agent:

- `composer:<agentId>` for Composer controls
- `panel:<agentId>` for the Agents pane

The refs used for outside-click detection use the same scoped identity. Each
`AgentModelSelect` receives `isOpen` only when its own identity matches.
Opening one picker therefore closes any other picker and renders exactly one
listbox.

Model selection remains keyed only by agent ID in the existing model registry.
Selecting a model in the Agents pane:

1. updates the shared selected model for that agent;
2. closes the scoped pane menu;
3. immediately updates the Composer model label; and
4. causes subsequent prompts to use the selected model through the existing
   request path.

No API, persistence, or agent configuration format changes are required.

### Preserve pinch zoom while preventing automatic zoom

Do not add `maximum-scale=1` or `user-scalable=no` to the viewport. User pinch
zoom remains available.

Apply two mobile safeguards:

1. Set `-webkit-text-size-adjust: 100%` and `text-size-adjust: 100%` on the
   application root so orientation changes do not inflate text.
2. At the mobile breakpoint, ensure editable `input`, `textarea`, and `select`
   controls inside the application have an effective font size of at least
   16px. This includes the Composer and management forms and prevents iOS
   focus auto-zoom at its source.

Buttons, static labels, message content, and desktop typography remain
unchanged. Existing visual viewport height/offset synchronization remains
responsible only for fitting the shell and overlays; it will not manipulate
browser scale or rewrite viewport metadata during orientation changes.

## Error Handling and Interaction Rules

- Clicking outside the open model picker closes it.
- Escape closes only the active scoped model picker before higher-level
  surfaces.
- A model picker with no models remains absent as it does today.
- Model-loading and disabled states retain their current behavior.
- Orientation changes do not blur inputs, discard Composer drafts, close
  overlays, or reset intentional user pinch zoom.

## Testing

### Model picker coverage

Add or extend Playwright coverage to:

- open the Agents pane model picker while the Composer picker for the same
  agent is present;
- assert exactly one listbox is rendered and it is anchored to the pane
  control;
- select a different model;
- assert both the pane control and Composer control display the new model;
- assert the next prompt uses that model; and
- verify outside-click and Escape still close the active picker.

### Mobile orientation coverage

Extend mobile tests for Android Chromium and iPhone WebKit to:

- verify the viewport continues to permit user scaling;
- verify the application root has a fixed 100% text-size adjustment;
- verify editable mobile controls have an effective font size of at least
  16px;
- alternate portrait and landscape dimensions multiple times;
- assert the application remains within the layout viewport after every
  transition; and
- assert the Composer draft and active overlay state are preserved.

Browser emulation cannot directly control physical-device Safari page scale,
so the tests validate the measurable causes and layout invariants. The iPhone
WebKit run provides the closest automated engine coverage.

## Acceptance Criteria

- Opening a Model menu in the Agents pane renders exactly one dropdown.
- The Composer Model menu remains closed while the pane menu is open.
- Selecting a pane model updates the Composer model label and subsequent model
  request for the same agent.
- Repeated orientation changes do not progressively enlarge or overflow the
  application.
- Mobile focus controls do not trigger small-font auto-zoom.
- Pinch zoom remains available because viewport scaling is not disabled.
- Existing desktop behavior, mobile overlays, model persistence, and
  non-editable typography remain unchanged.
