# Mobile Web Responsive Design

## Summary

Improve the existing Agents Chat web interface for phones without introducing a separate mobile application or a second navigation model. The desktop layout remains unchanged. On narrow screens, the existing left navigation becomes an overlay drawer opened from a new header button, while global and management features remain in the header overflow menu.

The first release provides complete chat, attachment, file viewing, and agent-management workflows. Nodes and schedules focus on routine mobile operations, with complex configuration remaining desktop-only. Both iPhone/WebKit and Android/Chromium are required test targets.

## Goals

- Preserve the current web layout, terminology, and component hierarchy.
- Make core chat workflows fully usable on iPhone and Android phones.
- Give the existing Chats/Files sidebar a dedicated mobile entry point.
- Keep Theme, Agents, Nodes, Schedules, and Settings in the existing overflow menu.
- Support complete Agent creation, editing, access management, and deletion on mobile.
- Reuse the same components and backend APIs across desktop and mobile.
- Preserve chat, composer, attachment, and scroll state while opening panels.
- Prepare a stable optional composer slot for a future voice-input capability.

## Non-goals

- Bottom navigation.
- A separate mobile page or duplicated mobile component tree.
- PWA manifests, service workers, offline caching, or install prompts.
- An actual speech-to-text engine in this release.
- Mobile optimization for complex Node connection configuration.
- Mobile optimization for creating Schedules or editing complex Cron definitions.
- A native iOS application or WeChat Mini Program.
- Changes to deployment atomicity or release switching.

## Responsive Layout

### Desktop

The existing desktop layout and interactions remain unchanged. The left sidebar stays visible according to its current state, and the existing header actions continue to work.

### Mobile

At widths of 900 pixels or less, matching the existing primary mobile breakpoint, the layout is:

```text
[menu]  [Logo] Agents Chat    [more] [Login user]

                 Current chat

[attach] [optional voice] [Message input] [Send]
```

Desktop behavior above 900 pixels must not change, and layout CSS and tests use the same breakpoint.

## Header and Navigation

### Left navigation button

A dedicated button at the left edge of the mobile header opens the existing Chats/Files sidebar as a left overlay drawer.

The drawer:

- Reuses the desktop sidebar and its Chats and Files tabs.
- Occupies the available viewport height and respects safe-area insets.
- Opens above the chat rather than pushing or resizing it.
- Closes when the user selects a chat or file, taps the backdrop, presses Escape, or activates the header button again.
- Locks background scrolling while open.
- Preserves the sidebar list and tab scroll positions across close and reopen.
- Restores focus to the opening button when closed.

Selecting a chat closes the drawer and shows that chat. Selecting a file closes the drawer and shows the file in the main content area; file contents are not rendered inside the narrow drawer.

### Overflow menu

The mobile overflow menu contains only:

- Theme
- Agents
- Nodes
- Schedules
- Settings

Chats and Files are removed from this menu because they are available through the dedicated left navigation button.

Theme may retain its existing nested menu. Agents, Nodes, and Schedules open their existing panels as mobile overlays. Settings uses its existing surface with a phone-width layout.

### Account control

The current login-user control remains a separate header action and does not move into the overflow menu. It continues to expose user information, administrator status where applicable, and sign-out.

## Overlay State and Interaction

Mobile layout state has one active overlay at a time:

```text
none
left-navigation
agents
nodes
schedules
settings
account
```

Opening one overlay closes any other active overlay. Opening or closing an overlay must not clear:

- The current chat or its rendered messages.
- The chat scroll position.
- Unsent composer text.
- Selected attachments.
- Sidebar tab and list scroll positions.

Overlay surfaces share backdrop, focus-management, body-scroll-locking, viewport, and safe-area behavior. Opening a mobile overlay adds a transient history entry. Browser back closes that overlay before navigating away, without changing desktop navigation history.

## Chat and Composer

Mobile chat retains the complete existing message experience, including Markdown, code blocks, tables, thinking content, tool execution, streaming responses, and attachments.

- Wide code blocks and tables scroll horizontally inside their message rather than widening the page.
- Sending a message keeps the composer visible.
- When the user has intentionally scrolled into history, streaming content does not force the view to the bottom; the existing or an equivalent "return to latest" control remains available.
- Streaming stop and send controls remain reachable above the keyboard and browser chrome.

The composer remains a single responsive component. Agent, model, and workflow controls stay available and may horizontally scroll or collapse when space is limited, but they must not displace the primary input and send control.

The layout must continue to use the existing `visualViewport`, dynamic viewport units, and safe-area foundations so that the composer follows the visible viewport when the software keyboard or browser toolbar changes its height. Portrait and landscape orientations are supported.

## Future Voice Capability

This release establishes an optional composer capability slot but does not provide speech recognition.

- The microphone button renders only when runtime configuration confirms that a voice-input capability is available.
- The default configuration has no voice capability, so no microphone button is shown.
- No disabled or "coming soon" microphone button is displayed.
- A future browser-WASM or server-side `whisper.cpp` implementation can use the same slot.
- Future transcription writes text through the existing programmatic composer-input interface.
- Transcription does not automatically send a message; the user can review and edit it first.

## Feature Scope

### Agents

Agents receive complete mobile support for authorized users:

- List Agents and inspect status.
- Select an Agent and its model for the current chat.
- Add an Agent on the server.
- Add an Agent from a remote Node.
- Edit name, command, arguments, working directory, environment variables, model-related settings, and other existing settings.
- Grant and revoke Agent access.
- Delete an Agent.

Mobile create and edit forms use a full-height sheet rather than a narrow desktop modal. Fields use a single-column layout. Long command, argument, and environment-variable values use suitable multiline or horizontally scrollable controls. The focused field and Save/Cancel controls remain reachable when the keyboard is open.

Submission is disabled while a save is active. Failures preserve entered values and display the backend error. Destructive actions require explicit confirmation. Existing authorization rules remain authoritative; the responsive UI must not grant additional capabilities.

### Files

Files are optimized for browsing and viewing:

- Browse directories and files.
- Search, filter, and refresh using existing capabilities.
- View supported text, Markdown, code, and image files.
- Retain file comments.
- Scroll long text and code horizontally within the viewer.

Complex file editing is not optimized for mobile in this release. Existing editing actions that are not safely usable at phone widths are hidden or accompanied by a clear prompt to use the desktop interface.

### Nodes

Nodes focus on status visibility and safe routine actions:

- View Node name, platform, online state, and basic status.
- View relevant connection errors.
- Refresh status and use other existing simple, safe actions.

Creating Nodes or modifying complex connection parameters is not optimized for mobile and directs the user to the desktop interface.

### Schedules

Schedules support routine monitoring and control:

- View the Schedule list and enabled state.
- Enable or disable an existing Schedule.
- View recent execution time, result, and run history.

Creating a Schedule, editing complex Cron expressions, and changing complex Agent or Workflow combinations are not optimized for mobile and direct the user to the desktop interface. Mobile actions use the existing backend APIs.

## Component Boundaries

- `PageHeader` owns the mobile left-navigation trigger and the revised overflow contents.
- `ChatShell` coordinates the active mobile overlay, backdrop, viewport sizing, and scroll locking.
- The existing sidebar renders as either the desktop sidebar or mobile left drawer; its data and business logic are not duplicated.
- Existing feature panels render in responsive overlay containers.
- `AgentsPanel` retains existing management logic and gains responsive full-screen form presentation.
- The composer exposes an optional capability-driven action slot without implementing speech recognition.
- `ChatPageClient` remains a composition layer. New interaction logic belongs in focused layout or feature hooks and helpers.

The implementation should prefer one typed overlay-state abstraction over multiple independent booleans when doing so can be introduced without unrelated refactoring.

## Accessibility

- Header controls have accessible names independent of their icons.
- Drawer and overlay surfaces expose appropriate dialog/navigation semantics.
- Focus moves into an opened overlay and returns to its trigger when closed.
- Keyboard users can close overlays with Escape.
- Tap targets meet a minimum practical phone size without changing desktop density.
- Active, disabled, loading, and error states are not communicated by color alone.
- Reduced-motion preferences are respected for drawer and overlay transitions.

## Error Handling

- Agent create, update, access, and delete failures display the backend error and retain editable form state where relevant.
- Nodes and Schedules load failures remain inside their panel and offer retry without breaking the current chat.
- File preview failures display a file-level error rather than replacing the whole application.
- Existing network and storage-unavailable handling remains authoritative.
- Failed operations must not be silently ignored or represented as successful.

## Playwright Test Strategy

### Device matrix

| Target | Playwright engine/device | Primary risks |
| --- | --- | --- |
| iPhone Safari and Chrome behavior | WebKit with iPhone device parameters | Safe areas, `visualViewport`, dynamic browser chrome, software keyboard, landscape |
| Android Chrome | Chromium with Pixel device parameters | Software keyboard resizing, browser-back overlay behavior, fixed positioning, scroll locking, landscape |
| Desktop Chrome | Desktop Chromium | Regression protection for the existing desktop sidebar and header |

iPhone Chrome uses the platform WebKit engine, so WebKit device coverage represents both Safari and Chrome rendering behavior on iOS. Android Chrome requires separate Chromium coverage.

### Shared mobile scenarios

The same core scenarios run against the iPhone and Android projects:

- The mobile header displays the left-navigation and overflow controls.
- The left-navigation control opens the existing Chats/Files sidebar.
- The overflow menu excludes Chats/Files and includes Theme, Agents, Nodes, Schedules, and Settings.
- Left and right overlays are mutually exclusive.
- Backdrop and Escape close an overlay.
- Opening and closing overlays preserves the current chat, scroll state, unsent composer text, and attachments.
- Chats can be selected and Files can be browsed and viewed.
- Composer text, attachments, send, and streaming-stop behavior remain usable.
- Authorized users can open Agent create and edit forms and complete representative management flows.
- Nodes status can be viewed.
- Schedules can be viewed and enabled or disabled.
- Portrait and landscape layouts remain usable.
- The microphone button is absent when no voice capability is configured.

### Platform-specific scenarios

- WebKit/iPhone validates safe-area insets, dynamic viewport changes, bottom browser chrome, and keyboard avoidance.
- Chromium/Android validates keyboard resizing, body scroll locking, fixed overlay positioning, and browser-back closing behavior.
- Desktop Chromium verifies that the existing desktop sidebar, header, panels, and composer do not adopt mobile behavior.

Shared scenarios should be parameterized across device projects rather than copied into separate files. Platform-specific cases remain focused to limit CI duration and maintenance.

## Acceptance Criteria

- Mobile users can navigate Chats and Files through a dedicated left header control.
- The mobile overflow menu contains only global and management features.
- Only one mobile overlay can be active at a time.
- Core chat, attachment, and Agent-management workflows are usable on both tested mobile engines.
- Composer and overlay controls remain reachable with the software keyboard open.
- State is preserved while panels open and close.
- Nodes and Schedules provide the agreed routine mobile operations and clearly defer complex configuration to desktop.
- No microphone control appears without an available voice capability.
- Desktop layout and behavior remain unchanged.
- iPhone/WebKit, Android/Chromium, and desktop Chromium Playwright coverage passes.
