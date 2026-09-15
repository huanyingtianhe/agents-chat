# Mobile Markdown Rendered View Design

## Goal

Display Markdown files as rendered Markdown on mobile, matching the desktop
viewing experience while keeping mobile file access read-only.

## Current Problem

`FileEditorPanel` routes every non-image file through the raw line renderer
whenever `mobileReadOnly` is true. This branch runs before the Markdown-specific
desktop rendering branch, so mobile users see source syntax such as `#`,
`**bold**`, and table delimiters instead of rendered content.

## File-Type Behavior

The mobile read-only branch becomes file-type aware:

- Markdown uses rendered view.
- Every non-Markdown type keeps its current mobile behavior.

Desktop Split, Live Edit, Review, conflict resolution, and save behavior remain
unchanged.

## Markdown Rendering

Mobile Markdown uses the existing rendering stack:

- `ReactMarkdown`;
- `remarkGfm`; and
- the shared `mdComponents`.

This keeps headings, emphasis, links, lists, tables, code blocks, and other GFM
content consistent with desktop preview and Chat Markdown.

The rendered content is placed in a dedicated mobile read-only viewer container
with the existing `.markdownBody` class. The container:

- scrolls vertically within the file workspace;
- keeps wide code blocks and tables horizontally scrollable;
- does not widen the page or mobile viewport; and
- preserves the current responsive typography and theme tokens.

## Controls and Editing

Mobile Markdown is rendered-only:

- no Raw/Rendered toggle is added;
- Split and Live Edit controls remain hidden;
- Save remains hidden;
- the existing `Use the desktop interface to edit files.` hint remains visible;
  and
- Close remains available.

The underlying file content and editor mode state are not rewritten merely to
produce mobile rendering.

## Comments

The comment toggle and `FileCommentSidebar` remain available so users can view
existing file comments.

Selecting rendered Markdown text to create a new comment is not included.
Mobile must not mount the desktop content-editable live editor or its selection
marker layers.

## Error Handling

No API contract changes are required. File listing, content loading, and error
handling continue through `useFileWorkspaceState` and the existing Files error
surface.

Malformed or unusual Markdown is rendered according to the existing
`ReactMarkdown` behavior. The UI does not silently fall back to the raw viewer,
because that would recreate inconsistent desktop/mobile behavior.

## Accessibility

- Rendered headings, lists, links, tables, and code retain semantic HTML.
- The file path remains visible in the toolbar.
- Existing comment and Close controls retain their accessible labels.
- Read-only content does not expose `contentEditable`.
- Horizontal overflow is contained within wide content rather than the page.

## Test Coverage

Update mobile Playwright coverage to serve Markdown containing a heading,
emphasis, list, table, and fenced code block. On both Android Chromium and
iPhone WebKit, verify:

1. the Markdown file opens after the Files drawer closes;
2. a rendered heading and semantic table are visible;
3. source markers are not displayed through `.fileContentLine`;
4. the rendered viewer contains `.markdownBody`;
5. wide code/table content remains contained by the viewer;
6. the comment toggle and desktop-editing hint remain visible;
7. Save, Split, Live Edit, and `contentEditable` are absent; and
8. a plain-text file still uses the raw line viewer.

Run TypeScript and production build validation after the targeted browser
coverage.

## Acceptance Criteria

- Opening a Markdown file on mobile shows rendered Markdown rather than source
  text.
- Mobile and desktop use the same Markdown parser and component mapping.
- Mobile remains read-only and does not open the software keyboard.
- Existing comments remain viewable.
- Non-Markdown file behavior is unchanged.
- Android Chromium and iPhone WebKit regression coverage passes.
