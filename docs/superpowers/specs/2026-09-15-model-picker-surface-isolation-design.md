# Model Picker Surface Isolation

## Scope

Opening an agent's model picker in the Agents panel must not also open the
Composer picker for the same agent. Selected models remain shared between
surfaces and continue to determine the model used for subsequent prompts.

## Design

Keep a single controlled open-menu state, keyed by surface and agent:

- `composer:<agentId>` identifies the Composer picker.
- `panel:<agentId>` identifies the Agents panel picker.

Outside-click refs use the same identity. Each picker is open only when its
own identity matches. Opening another picker closes the previous one.
Selected model values remain keyed only by agent ID; no API or persistence
format changes are required.

## Acceptance

- Opening the panel picker renders exactly one listbox.
- Selecting a model updates both panel and Composer labels.
- The next prompt uses the selected model.
- Outside-click and Escape close the active picker.
- Missing-model, loading, and disabled states retain existing behavior.

Coverage lives in `tests/agent-composer-default-model.spec.ts`.

## Excluded Work

The original document also proposed iOS orientation/automatic-zoom changes.
Those experiments failed physical iPhone acceptance and are excluded from
this mobile UX PR, including their implementation, tests, and design plans.
This PR makes no claim to fix rotation-related font enlargement.
