import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Source-shape guard for the refreshed Agent edit/add dialog button styles.
// Goal:
//  - Primary Save / Grant button: solid accent CTA via shared class (no hardcoded colors).
//  - Cancel: subtle ghost (existing .secondary, no change required beyond removing hardcoded fills).
//  - Delete: outlined danger by default, fills on hover. Uses --danger CSS var, no hardcoded hex.
//  - Grant: uses a shared class instead of inline style+padding.
//  - All themed via CSS variables.

const cssSource = readFileSync(
  new URL('../app/features/layout/components/ChatShell.css', import.meta.url),
  'utf8',
);
const panelSource = readFileSync(
  new URL('../app/features/agents/components/AgentsPanel.tsx', import.meta.url),
  'utf8',
);

// 1. Old hardcoded danger colors are gone from the modal action rules.
assert.doesNotMatch(
  cssSource,
  /\.chatPageRoot \.modalActions \.danger\s*\{[^}]*#d9363e/i,
  'modalActions .danger should not hardcode #d9363e; use var(--danger)',
);
assert.doesNotMatch(
  cssSource,
  /\.chatPageRoot \.modalActions \.danger:hover\s*\{[^}]*#c22d35/i,
  'modalActions .danger:hover should not hardcode #c22d35',
);

// 2. Primary CTA rule exists and uses --accent.
assert.match(
  cssSource,
  /\.modal button\.primary\s*\{[^}]*background:\s*var\(--accent\)/,
  '.modal button.primary should background with var(--accent)',
);
assert.match(
  cssSource,
  /\.modal button\.primary\s*\{[^}]*color:\s*#fff/i,
  '.modal button.primary should use white text on accent fill',
);

// 3. Danger rule is outlined-by-default and uses --danger, with a fill-on-hover rule.
assert.match(
  cssSource,
  /\.modal button\.danger\s*\{[^}]*background:\s*transparent/,
  '.modal button.danger should be outlined (transparent background) by default',
);
assert.match(
  cssSource,
  /\.modal button\.danger\s*\{[^}]*color:\s*var\(--danger\)/,
  '.modal button.danger should use var(--danger) for text color',
);
assert.match(
  cssSource,
  /\.modal button\.danger\s*\{[^}]*border:[^;]*var\(--danger\)/,
  '.modal button.danger should use var(--danger) for border',
);

assert.match(
  cssSource,
  /\.modal button\.danger:hover\s*\{[^}]*background:\s*var\(--danger\)/,
  '.modal button.danger:hover should fill with var(--danger)',
);
assert.match(
  cssSource,
  /\.modal button\.danger:hover\s*\{[^}]*color:\s*#fff/i,
  '.modal button.danger:hover should switch text to white',
);

// 3b. Checkbox/radio inputs are excluded from the dark text-input styling
//     so they don't render as solid dark squares.
assert.match(
  cssSource,
  /\.chatPageRoot \.modal input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/,
  'modal input rule must exclude checkbox/radio so they keep their native appearance',
);

// 3c. Light themes must opt into color-scheme: light so native form controls
//     (checkboxes, scrollbars) don't inherit the root dark color-scheme.
const globalsCssSource = readFileSync(
  new URL('../app/globals.css', import.meta.url),
  'utf8',
);
assert.match(
  globalsCssSource,
  /\.page\[data-theme="claude"\][\s\S]{0,200}color-scheme:\s*light/,
  'Claude theme should set color-scheme: light so checkboxes render light',
);
assert.match(
  globalsCssSource,
  /\.page\[data-theme="chatgpt"\][\s\S]{0,200}color-scheme:\s*light/,
  'ChatGPT theme should set color-scheme: light so checkboxes render light',
);

// 4. AgentsPanel uses .primary for Save and Grant, drops inline padding/fontSize on Grant,
//    and drops the trash emoji on Delete (text-only).
assert.match(
  panelSource,
  /className="primary"[^>]*onClick=\{[^}]*saveAgentSettings/,
  'Save button should use className="primary"',
);
assert.match(
  panelSource,
  /className="primary[^"]*"[^>]*onClick=\{[^}]*addAccess[\s\S]{0,200}>Grant</,
  'Grant button should use className containing "primary"',
);
assert.doesNotMatch(
  panelSource,
  />🗑️\s*Delete</,
  'Delete button should be text-only (no 🗑️ emoji)',
);

console.log('agent-dialog-buttons.test.mjs: all assertions passed');
