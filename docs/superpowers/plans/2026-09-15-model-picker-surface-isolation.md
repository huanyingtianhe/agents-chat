# Model Picker Surface Isolation Implementation Record

The completed model-picker work is retained independently of the abandoned
orientation-fix experiments.

## Implementation

- `app/features/agents/agentModelMenuHelpers.ts` defines the surface-scoped
  menu key.
- `app/features/agents/hooks/useAgentPanelState.ts` retains one open menu and
  the matching outside-click refs.
- `app/features/agents/components/AgentsPanel.tsx` uses panel-scoped identity.
- `app/features/composer/components/ComposerTargetControls.tsx` uses
  Composer-scoped identity.
- `tests/agent-composer-default-model.spec.ts` covers a single open menu,
  synchronized model labels, and the next prompt's model.

## Validation

Run against an isolated app:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 npx playwright test \
  --config tests/playwright.config.ts --project=desktop-chromium \
  tests/agent-composer-default-model.spec.ts
```

## Separation from Orientation Work

The mobile UX branch starts at `e64e9e4`, before orientation experiments.
The independent initial-chat restoration improvement from `930c25e` is
retained: loading state, saved title, failure notification, retry, and
cancellation when the user selects another chat.

No orientation scale recovery, text-inflation override, rotation scroll hook,
CSS-owned root rewrite, or orientation-specific validation workflow is included.
The existing browser-viewport shell remains as it was before those experiments.
