import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pageSource = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const clientSource = readFileSync(new URL('../app/features/chat/ChatPageClient.tsx', import.meta.url), 'utf8');
const composerSource = readFileSync(new URL('../app/features/composer/components/ChatComposer.tsx', import.meta.url), 'utf8');
const composerCss = readFileSync(new URL('../app/features/composer/components/ChatComposer.css', import.meta.url), 'utf8');

const shellStart = composerSource.indexOf('className={`composerShell');
assert.ok(shellStart >= 0, 'composer shell should exist in ChatComposer');
const shellSource = composerSource.slice(shellStart, composerSource.indexOf('</section>', shellStart));

const attachmentIndex = shellSource.indexOf('<AttachmentList');
const textRowIndex = shellSource.indexOf('className="composerTextRow"');
const toolbarIndex = shellSource.indexOf('className="composerToolbar"');
const attachButtonIndex = shellSource.indexOf('className="attachButton"');
const attachIconIndex = shellSource.indexOf('className="attachButtonIcon"');
const targetPillsIndex = shellSource.indexOf('{targetControls}');
const sendActionsIndex = shellSource.indexOf('className="composerActions composerToolbarActions"');

assert.ok(clientSource.includes('<ChatComposer'), 'ChatPageClient.tsx should render ChatComposer');
assert.ok(attachmentIndex >= 0, 'composer should render attachments in the shell');
assert.ok(textRowIndex >= 0, 'composer should have a dedicated text row');
assert.ok(toolbarIndex >= 0, 'composer should have a bottom toolbar');
assert.ok(attachmentIndex < textRowIndex, 'attachments should render above the text input');
assert.ok(textRowIndex < toolbarIndex, 'text input should render above the bottom toolbar');
assert.ok(toolbarIndex < attachButtonIndex, 'file attachment button should live in the bottom toolbar');
assert.ok(attachButtonIndex < attachIconIndex, 'file attachment button should include an icon span');
assert.doesNotMatch(shellSource.slice(attachButtonIndex, targetPillsIndex), /attachButtonLabel|>Files</, 'file attachment button should be icon-only');
assert.ok(toolbarIndex < targetPillsIndex, 'agent/model target controls should live in the bottom toolbar');
assert.ok(toolbarIndex < sendActionsIndex, 'send controls should live in the bottom toolbar');

const textRowSource = shellSource.slice(textRowIndex, toolbarIndex);
assert.doesNotMatch(textRowSource, /attachButton|targetControls|composerActions/, 'text row should contain only the textarea controls, not toolbar controls');

assert.match(composerCss, /\.composerToolbar\s*\{[\s\S]*?display:\s*flex;[\s\S]*?justify-content:\s*space-between;/, 'bottom toolbar should lay out controls horizontally');
assert.match(composerCss, /\.composerTextRow\s*\{[\s\S]*?display:\s*flex;/, 'text row should have its own layout block');
assert.match(composerCss, /\.attachmentTray\s*\{[\s\S]*?padding:\s*0 0 2px;/, 'attachment tray should sit as the compact top strip');
assert.match(composerCss, /\.attachButton\s*\{[\s\S]*?width:\s*32px;[\s\S]*?border-radius:\s*999px;/, 'file attachment button should use a compact rounded icon-button shape');
assert.doesNotMatch(composerCss, /\.attachButtonLabel\s*\{/, 'file attachment button should not include visible label styles');

console.log('composer layout checks passed');
