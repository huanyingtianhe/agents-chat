# ChatGPT Send Button Color Design

## Goal

Make the ChatGPT-mode send button use the same visual color treatment as the inactive `# workflow` composer pill shown in the composer toolbar.

## Scope

- Apply the change only to the `chatgpt` theme.
- Reuse the inactive workflow pill's palette: `--accent-soft` background, `--accent` foreground, and `--border-strong` border.
- Remove the send button's default gradient and shadow in ChatGPT mode so its color treatment matches the pill.
- Preserve the button's size, accessible label, disabled state, and hover behavior.

## Design

The existing workflow pill receives `background: var(--accent-soft)`, `color: var(--accent)`, and `border-color: var(--border-strong)` through `.targetPill`. The ChatGPT theme will define the corresponding `--send-button-bg`, `--send-button-color`, `--send-button-border`, and `--send-button-shadow` variables. This keeps the generic composer CSS unchanged and limits the visual adjustment to the intended theme.

## Verification

Add a Playwright regression test that selects ChatGPT mode, fills the composer, and verifies that the send button resolves to the same background color, foreground color, border color, and no box shadow as the inactive workflow pill.
