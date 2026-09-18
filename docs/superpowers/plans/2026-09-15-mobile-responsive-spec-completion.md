# Mobile Responsive Spec Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining gaps between the mobile responsive implementation and `docs/superpowers/specs/2026-09-14-mobile-web-responsive-design.md`.

**Architecture:** Extend the existing Files workspace rather than introducing a mobile-only file browser. The existing `/api/markdown` route will return bounded image data URLs, while the file workspace hook remains the source of truth for preview kind, filtering, and refresh behavior. Add shared Playwright scenarios so both Android Chromium and iPhone WebKit exercise the missing state-preservation and orientation requirements.

**Tech Stack:** Next.js 16 App Router, React 19, strict TypeScript, feature-local CSS, Node.js assertion tests, Playwright.

---

## Scope and File Map

- Modify `app/api/markdown/route.ts` to list supported images and return bounded image previews.
- Modify `app/features/files/fileWorkspaceHelpers.ts` to classify supported image files.
- Modify `app/features/files/fileWorkspaceTypes.ts` and `app/features/files/hooks/fileWorkspaceHookTypes.ts` to type preview kind and file filtering.
- Modify `app/features/files/hooks/useFileWorkspaceState.ts` to retain preview kind, expose search, refresh file lists, and report list failures.
- Modify `app/features/files/components/FileTreePanel.tsx` to render search and refresh controls.
- Modify `app/features/files/components/FileEditorPanel.tsx` to render image previews without editing controls.
- Modify `app/features/files/components/FileWorkspacePanel.css` for responsive file controls and image containment.
- Modify `tests/helpers/mobileChatFixture.ts` and `tests/mobile-responsive.spec.ts` for cross-device acceptance coverage.
- Create `tests/image-files-preview.test.mjs` for the backend/UI image contract.

### Task 1: Add failing image-preview contract coverage

- [x] Add `tests/image-files-preview.test.mjs` assertions that supported image extensions are not skipped, image reads are bounded and base64 encoded, and `FileEditorPanel` renders an image preview.
- [x] Run `node tests/image-files-preview.test.mjs`.
- [x] Confirm it fails because image extensions are currently skipped and no image preview exists.

### Task 2: Implement bounded image previews

- [x] Add an image-extension-to-MIME map and `isImageFile()` helper.
- [x] Return `kind: "image"` and a `data:<mime>;base64,...` payload for local image reads, rejecting images larger than the configured preview limit.
- [x] Track the response `kind` in `useFileWorkspaceState` and render an `<img>` preview with the selected filename as alt text.
- [x] Hide text editing and line-comment controls for image content while keeping the file viewer and close action available.
- [x] Run `node tests/image-files-preview.test.mjs` and `npm run build`.

### Task 3: Add Files search and refresh

- [x] Add a failing shared mobile scenario that searches the file tree, refreshes the list, and opens an image.
- [x] Add typed `mdFileQuery`, filtered tree calculation, and `refreshMdFiles()` state to `useFileWorkspaceState`.
- [x] Add an accessible `Search files` input and `Refresh files` button to `FileTreePanel`; expand matching directory paths while searching.
- [x] Surface list failures with a Retry action instead of silently presenting an empty tree.
- [x] Run the shared mobile scenario on Android Chromium and iPhone WebKit.

### Task 4: Complete state and orientation acceptance coverage

- [x] Extend the overlay state test to attach a file, scroll chat history away from the bottom, open and close navigation, and verify draft, attachment, message, and scroll state are unchanged.
- [x] Add a shared landscape scenario that resizes to `844x390` and verifies header, composer, send control, and an overlay remain inside the viewport.
- [x] Run both mobile spec files against Android Chromium and iPhone WebKit (52/52 passing).
- [x] Run the desktop header regression scenario and `npm run build`.

### Task 5: Final spec review

- [x] Compare each design acceptance criterion against implementation and an automated scenario.
- [x] Confirm the branch diff remains based on `upstream/main` and contains no safe-restart, storage-backup, or PM2 files.
- [x] Commit the completed spec work.
