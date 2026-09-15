# Mobile Markdown Rendered View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Markdown files as semantic read-only Markdown on mobile while leaving all non-Markdown files and desktop editing behavior unchanged.

**Architecture:** Split the existing `mobileReadOnly` rendering branch by Markdown file type inside `FileEditorPanel`. Reuse the desktop `ReactMarkdown`, `remarkGfm`, and `mdComponents` stack in a mobile viewer container, while preserving the existing raw line renderer as the fallback for every other mobile file type.

**Tech Stack:** React 19, TypeScript, `react-markdown`, `remark-gfm`, feature-local CSS, Playwright Android Chromium and iPhone WebKit.

---

### Task 1: Add Failing Mobile Markdown Rendering Coverage

**Files:**
- Modify: `tests/helpers/mobileChatFixture.ts:291-310`
- Modify: `tests/mobile-responsive.spec.ts:299-351`

- [ ] **Step 1: Enrich the mobile Markdown fixture**

In `tests/helpers/mobileChatFixture.ts`, replace the generic Markdown content
with content that proves semantic rendering and add a text-file response:

```ts
const MOBILE_MARKDOWN_CONTENT = `# Mobile rendered heading

This is **rendered emphasis**.

- first rendered item
- second rendered item

| Name | Value |
| --- | --- |
| Mobile | Rendered |

\`\`\`ts
const mobileRendered = true;
\`\`\``;
```

Update the `/api/markdown` path response:

```ts
: path === 'notes.txt'
  ? {
      path,
      content: '# Plain text heading\\n\\n**Plain text emphasis**',
      kind: 'text',
      mtime: '2026-09-14T00:00:00.000Z',
    }
  : {
      path,
      content: MOBILE_MARKDOWN_CONTENT,
      kind: 'markdown',
      mtime: '2026-09-14T00:00:00.000Z',
    }
```

Add the plain text file to the list:

```ts
{ path: 'notes.txt', name: 'notes.txt', mtime: '2026-09-14T00:00:00.000Z' },
```

- [ ] **Step 2: Add rendered Markdown assertions to the existing mobile Files test**

After `README.md` opens in `tests/mobile-responsive.spec.ts`, add:

```ts
const mobileMarkdown = page.locator('.mobileMarkdownViewer');
await expect(mobileMarkdown).toBeVisible();
await expect(mobileMarkdown.locator('.markdownBody')).toBeVisible();
await expect(mobileMarkdown.getByRole('heading', {
  name: 'Mobile rendered heading',
  level: 1,
})).toBeVisible();
await expect(mobileMarkdown.locator('strong')).toHaveText('rendered emphasis');
await expect(mobileMarkdown.getByRole('listitem')).toHaveCount(2);
await expect(mobileMarkdown.locator('table')).toBeVisible();
await expect(mobileMarkdown.locator('pre code')).toContainText('mobileRendered');
await expect(page.locator('.fileContentLine')).toHaveCount(0);
await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
```

Keep and reassert the existing behavior:

```ts
await expect(page.getByTitle('Toggle comments')).toBeVisible();
await expect(page.getByText('Use the desktop interface to edit files.')).toBeVisible();
await expect(page.getByRole('button', { name: /Save/ })).toHaveCount(0);
await expect(page.getByRole('button', { name: 'Split' })).toHaveCount(0);
await expect(page.getByRole('button', { name: 'Live Edit' })).toHaveCount(0);
```

- [ ] **Step 3: Add the non-Markdown regression assertion**

After closing `README.md`, reopen Files, choose the same Agent, select
`notes.txt`, and assert:

```ts
await page.getByRole('button', { name: 'notes.txt' }).click();
await expect(page.locator('.mobileMarkdownViewer')).toHaveCount(0);
await expect(page.locator('.fileContentWithLines')).toBeVisible();
await expect(page.locator('.fileLineText').first()).toHaveText('# Plain text heading');
```

Close the file before the existing Composer-draft restoration assertion.

- [ ] **Step 4: Run the Android test and verify it fails**

Start the temporary development server:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=admin123 NEXTAUTH_URL=http://localhost:3011 \
  npm run dev -- --port 3011
```

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium \
  -g "closes the drawer after selecting a file"
```

Expected: FAIL because `.mobileMarkdownViewer` is absent and Markdown is still
rendered as `.fileContentLine` source text.

- [ ] **Step 5: Commit the failing regression test**

```bash
git add tests/helpers/mobileChatFixture.ts tests/mobile-responsive.spec.ts
git commit -m "test: cover rendered mobile Markdown files"
```

Include the required `Co-authored-by` trailer.

### Task 2: Render Markdown in the Mobile Read-Only Viewer

**Files:**
- Modify: `app/features/files/components/FileEditorPanel.tsx:211-230`
- Modify: `app/features/files/components/FileWorkspacePanel.css:74-85,157-165`

- [ ] **Step 1: Split the mobile read-only branch by Markdown type**

In `FileEditorPanel.tsx`, keep image preview first, then insert a Markdown-only
branch before the existing general `mobileReadOnly` branch:

```tsx
{(mobileReadOnly || !workspace.mdConflict) && (imagePreview ? (
  <div className="mdImagePreviewWrap">
    <img className="mdImagePreview" src={workspace.mdFileContent} alt={filePath} />
  </div>
) : mobileReadOnly && isMarkdownFile(filePath) ? (
  <div className="mobileMarkdownViewer">
    <div className="markdownBody">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {workspace.mdEditContent}
      </ReactMarkdown>
    </div>
  </div>
) : mobileReadOnly ? (
  <div className="mdEditorSimple">
    <div
      className="fileContentWithLines"
      ref={selection.fileContentRef}
      onMouseUp={selection.handleTextSelection}
      onScroll={selection.handleFileContentScroll}
    >
      {renderFileLines()}
    </div>
    {renderAddCommentButton()}
  </div>
```

Do not set `contentEditable`, change `mdEditorMode`, call
`setMdLiveElementRef`, or mount live comment marker layers in the new branch.

- [ ] **Step 2: Add contained mobile viewer styling**

In `FileWorkspacePanel.css`, add:

```css
.mobileMarkdownViewer {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 20px clamp(16px, 5vw, 28px) 32px;
  background: var(--panel-bg);
}

.mobileMarkdownViewer .markdownBody {
  min-width: 0;
  max-width: 760px;
  margin: 0 auto;
}

.mobileMarkdownViewer .markdownBody pre,
.mobileMarkdownViewer .markdownBody .tableScroll {
  max-width: 100%;
  overflow-x: auto;
}
```

Inside `@media (max-width: 900px)`, add:

```css
.mobileMarkdownViewer {
  padding: 16px 14px calc(24px + env(safe-area-inset-bottom));
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
```

Use the shared Markdown styles instead of introducing a second typography
system.

- [ ] **Step 3: Run the focused Android test**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium \
  -g "closes the drawer after selecting a file"
```

Expected: PASS.

- [ ] **Step 4: Run the focused iPhone WebKit test**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit \
  -g "closes the drawer after selecting a file"
```

Expected: PASS.

- [ ] **Step 5: Run TypeScript and formatting checks**

Run:

```bash
npx tsc --noEmit
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit the mobile viewer**

```bash
git add app/features/files/components/FileEditorPanel.tsx \
  app/features/files/components/FileWorkspacePanel.css
git commit -m "fix: render Markdown files on mobile"
```

Include the required `Co-authored-by` trailer.

### Task 3: Cross-Browser Regression and Deployment

**Files:**
- Verify: `app/features/files/components/FileEditorPanel.tsx`
- Verify: `app/features/files/components/FileWorkspacePanel.css`
- Verify: `tests/helpers/mobileChatFixture.ts`
- Verify: `tests/mobile-responsive.spec.ts`

- [ ] **Step 1: Run both complete mobile suites**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=android-chromium

PLAYWRIGHT_BASE_URL=http://localhost:3011 \
  npx playwright test --config tests/playwright.config.ts \
  tests/mobile-responsive.spec.ts \
  --project=iphone-webkit
```

Expected: all tests pass in both projects.

- [ ] **Step 2: Stop the temporary development server**

Stop the exact shell session used to start port 3011. Verify the process has
ended rather than using a name-based kill.

- [ ] **Step 3: Restore generated Next.js type path if necessary**

If `next-env.d.ts` changed from production to development routes, restore:

```ts
import "./.next/types/routes.d.ts";
```

Run:

```bash
git diff --check
git status --short
```

Expected: only intended files and the pre-existing untracked
`.agents-chat-storage.json` remain.

- [ ] **Step 4: Stop production before rebuilding**

Ask the user to run:

```bash
sudo systemctl stop agents-chat.service
```

Do not ask for the sudo password. Verify:

```bash
systemctl is-active agents-chat.service
```

Expected: `inactive`.

- [ ] **Step 5: Build production**

Run:

```bash
npm run build
```

Expected: compilation, TypeScript, page generation, and optimization complete
successfully. Existing NFT tracing warnings are allowed; build errors are not.

- [ ] **Step 6: Start and verify production**

Ask the user to run:

```bash
sudo systemctl start agents-chat.service
```

Then run:

```bash
systemctl is-active agents-chat.service
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://localhost:3010/login
```

Expected: `active` and HTTP `200`.

- [ ] **Step 7: Perform the final device check**

On mobile:

1. Open Files and select a Markdown file.
2. Confirm headings, emphasis, lists, tables, and code are rendered.
3. Confirm no raw Markdown source lines or editing controls appear.
4. Confirm comments and Close remain available.
5. Open a plain-text or source-code file and confirm it remains raw.

- [ ] **Step 8: Commit validation-only corrections if needed**

If browser validation required selector or fixture corrections:

```bash
git add tests/helpers/mobileChatFixture.ts tests/mobile-responsive.spec.ts
git commit -m "test: stabilize mobile Markdown coverage"
```

Include the required `Co-authored-by` trailer. Do not create an empty commit.
