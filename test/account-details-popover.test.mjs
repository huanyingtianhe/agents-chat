import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Source-shape guard for the account-details popover that opens when the
// signed-in user clicks their username in the header user chip.
// Goal:
//  - Username is a clickable button (not a static span) that toggles the popover.
//  - Popover (role="dialog") shows Name, Email, Role and a Sign out action.
//  - Popover closes on outside-click and Escape.
//  - ChatPageClient passes the user's email and image into PageHeader.
//  - Popover is themed via CSS variables (no hardcoded colors).

const headerSource = readFileSync(
  new URL('../app/features/layout/components/PageHeader.tsx', import.meta.url),
  'utf8',
);
const clientSource = readFileSync(
  new URL('../app/features/chat/ChatPageClient.tsx', import.meta.url),
  'utf8',
);
const cssSource = readFileSync(
  new URL('../app/features/layout/components/ChatShell.css', import.meta.url),
  'utf8',
);

// 1. PageHeader accepts the new account props.
assert.match(
  headerSource,
  /userEmail\?:\s*string\s*\|\s*null/,
  'PageHeaderProps should declare an optional userEmail prop',
);
assert.match(
  headerSource,
  /userImage\?:\s*string\s*\|\s*null/,
  'PageHeaderProps should declare an optional userImage prop',
);

// 2. The username is a real button that toggles the account popover.
assert.match(
  headerSource,
  /const \[showAccount, setShowAccount\] = useState\(false\)/,
  'PageHeader should track popover visibility with showAccount state',
);

// 2b. The chip avatar shows the account photo when available, with a
//     letter fallback when there is no image.
assert.match(
  headerSource,
  /userImage \? \([\s\S]*?className="userAvatar userAvatarImage"[\s\S]*?src=\{userImage\}[\s\S]*?\) : \([\s\S]*?className="userAvatar">\{\(authLabel \|\| '\?'\)\[0\]\.toUpperCase\(\)\}/,
  'The chip avatar should render the user photo when present and fall back to the initial',
);
assert.match(
  headerSource,
  /className="userName userNameButton"[\s\S]{0,200}onClick=\{\(\) => setShowAccount\(\(v\) => !v\)\}/,
  'The username should be a button that toggles showAccount',
);
assert.match(
  headerSource,
  /aria-haspopup="dialog"/,
  'The username button should advertise a dialog popup for accessibility',
);

// 3. The popover renders as a dialog with Name, Email and Role rows.
assert.match(
  headerSource,
  /showAccount && \([\s\S]*?role="dialog"[\s\S]*?aria-label="Account details"/,
  'Account popover should render conditionally as an accessible dialog',
);
for (const label of ['Name', 'Email', 'Role']) {
  assert.match(
    headerSource,
    new RegExp(`<span className="accountMenuLabel">${label}</span>`),
    `Account popover should include a ${label} row`,
  );
}
assert.match(
  headerSource,
  /\{userEmail \|\| '—'\}/,
  'Account popover should display the user email with a fallback dash',
);
assert.match(
  headerSource,
  /\{isAdmin \? 'Administrator' : 'User'\}/,
  'Account popover should display the resolved role',
);
assert.match(
  headerSource,
  /className="accountMenuSignOut"[\s\S]{0,120}onClick=\{\(\) => \{ setShowAccount\(false\); onSignOut\(\); \}\}/,
  'Account popover should offer a Sign out action that closes the popover',
);

// 4. The popover closes on outside-click and Escape.
assert.match(
  headerSource,
  /if \(!showAccount\) return;[\s\S]*?accountRef\.current\?\.contains[\s\S]*?setShowAccount\(false\)/,
  'Account popover should close on outside pointer-down',
);
assert.match(
  headerSource,
  /event\.key === 'Escape'\) setShowAccount\(false\)/,
  'Account popover should close when Escape is pressed',
);

// 5. ChatPageClient feeds the user email + image into PageHeader.
assert.match(
  clientSource,
  /userEmail=\{session\?\.user\?\.email\}/,
  'ChatPageClient should pass session user email to PageHeader',
);
assert.match(
  clientSource,
  /userImage=\{session\?\.user\?\.image\}/,
  'ChatPageClient should pass session user image to PageHeader',
);

// 6. Popover styling is themed via CSS variables, not hardcoded colors.
assert.match(
  cssSource,
  /\.chatPageRoot \.accountMenu\s*\{[\s\S]*?background:\s*var\(--panel-strong\)/,
  '.accountMenu should use the themed panel background',
);
assert.match(
  cssSource,
  /\.chatPageRoot \.accountMenuSignOut:hover\s*\{[\s\S]*?color:\s*var\(--accent\)/,
  '.accountMenuSignOut:hover should use the themed accent color',
);

console.log('account-details-popover.test.mjs: all assertions passed');
