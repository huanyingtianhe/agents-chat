import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const composerTargetControlsSource = readFileSync(
  new URL('../app/features/composer/components/ComposerTargetControls.tsx', import.meta.url),
  'utf8',
);
const workflowPickerSource = readFileSync(
  new URL('../app/features/orchestration/components/WorkflowPicker.tsx', import.meta.url),
  'utf8',
);

assert.match(
  composerTargetControlsSource,
  /<span className="workflowPillIcon" aria-hidden="true">#<\/span>/,
  'Composer workflow pill should use a # icon like agent pills use @',
);
assert.doesNotMatch(
  composerTargetControlsSource,
  /📋\s*\{pendingWorkflowName/,
  'Composer workflow pill should not use the clipboard emoji icon',
);

assert.match(
  workflowPickerSource,
  /<span className="wfPickerItemIcon" aria-hidden="true">#<\/span>/,
  'Workflow picker rows should use the # workflow icon',
);
assert.doesNotMatch(
  workflowPickerSource,
  /📋|💾/,
  'Workflow picker rows should not mix clipboard/save emoji icons for workflows',
);

console.log('workflow icon style checks passed');