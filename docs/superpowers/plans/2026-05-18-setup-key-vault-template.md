# Setup Key Vault Template Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove hard-coded Key Vault defaults from tracked setup files and generate node setup ZIPs with deployment-specific Key Vault values from environment variables.

**Architecture:** Keep `setup-files/setup-node.ps1` as a public-safe template with placeholders. Update `app/api/nodes/setup/route.ts` to render a temporary copy of the setup script using `RELAY_KEY_VAULT_NAME` and `RELAY_KEY_VAULT_SECRET_NAME` before zipping it with `relay-listener.js`; tracked files remain unchanged. Document the new env vars and include the already-requested `agents.json` sanitization.

**Tech Stack:** Next.js 16 App Router route handler, Node `fs/promises`, PowerShell setup script, Playwright/Node source-shape tests, JSON config.

---

## File structure

- Modify `setup-files/setup-node.ps1`: replace hard-coded Key Vault parameter defaults with placeholders.
- Modify `app/api/nodes/setup/route.ts`: render a temporary setup script from env values before creating the ZIP.
- Modify `test/agent-user-request-route.test.mjs`: add source-shape assertions for the setup template, setup ZIP route, and sanitized `agents.json`.
- Modify `.env.example`: document `RELAY_KEY_VAULT_NAME` and `RELAY_KEY_VAULT_SECRET_NAME`.
- Modify `README.md`: document deploy-time setup ZIP templating behavior.
- Modify `agents.json`: keep the already-applied empty public-safe agent list.

---

### Task 1: Setup ZIP templating

**Files:**
- Modify: `test/agent-user-request-route.test.mjs`
- Modify: `setup-files/setup-node.ps1`
- Modify: `app/api/nodes/setup/route.ts`
- Modify: `agents.json`

- [ ] **Step 1: Add failing source-shape tests**

In `test/agent-user-request-route.test.mjs`, add these imports after the existing imports:

```js
import path from 'node:path';
```

After `const routeSource = ...`, add these source constants:

```js
const setupRouteSource = readFileSync(new URL('../app/api/nodes/setup/route.ts', import.meta.url), 'utf8');
const setupNodeScriptSource = readFileSync(new URL('../setup-files/setup-node.ps1', import.meta.url), 'utf8');
const agentsConfigSource = readFileSync(new URL('../agents.json', import.meta.url), 'utf8');
const agentsConfig = JSON.parse(agentsConfigSource);
```

Before `console.log('agent user request route shape checks passed');`, add these assertions:

```js
assert.match(
  setupNodeScriptSource,
  /\[string\]\$KeyVaultName\s*=\s*"__RELAY_KEY_VAULT_NAME__"/,
  'setup-node.ps1 should use a Key Vault name placeholder instead of a committed deployment value',
);

assert.match(
  setupNodeScriptSource,
  /\[string\]\$SecretName\s*=\s*"__RELAY_KEY_VAULT_SECRET_NAME__"/,
  'setup-node.ps1 should use a Key Vault secret-name placeholder instead of a committed deployment value',
);

assert.doesNotMatch(
  setupNodeScriptSource,
  /committed-key-vault-name|committed-secret-name/,
  'setup-node.ps1 should not commit concrete Key Vault defaults',
);

assert.match(
  setupRouteSource,
  /const\s+SETUP_KEY_VAULT_NAME_PLACEHOLDER\s*=\s*['"]__RELAY_KEY_VAULT_NAME__['"]/,
  'setup ZIP route should define the Key Vault name placeholder',
);

assert.match(
  setupRouteSource,
  /const\s+SETUP_KEY_VAULT_SECRET_PLACEHOLDER\s*=\s*['"]__RELAY_KEY_VAULT_SECRET_NAME__['"]/,
  'setup ZIP route should define the Key Vault secret-name placeholder',
);

assert.match(
  setupRouteSource,
  /function\s+escapePowerShellDoubleQuotedString[\s\S]*?replace\([\s\S]*?`/g[\s\S]*?replace\([\s\S]*?\$/g[\s\S]*?replace\([\s\S]*?"/g/,
  'setup ZIP route should escape env values before embedding them in a PowerShell double-quoted string',
);

assert.match(
  setupRouteSource,
  /function\s+renderSetupNodeScript[\s\S]*?process\.env\.RELAY_KEY_VAULT_NAME[\s\S]*?process\.env\.RELAY_KEY_VAULT_SECRET_NAME[\s\S]*?SETUP_KEY_VAULT_NAME_PLACEHOLDER[\s\S]*?SETUP_KEY_VAULT_SECRET_PLACEHOLDER/,
  'setup ZIP route should render setup-node.ps1 placeholders from deployment environment variables',
);

assert.match(
  setupRouteSource,
  /const\s+stagedPs1Path\s*=\s*path\.join\(tempDir,\s*['"]setup-node\.ps1['"]\)[\s\S]*?await\s+fs\.writeFile\(stagedPs1Path,\s*renderSetupNodeScript\(setupNodeScript\),\s*['"]utf-8['"]\)[\s\S]*?Compress-Archive[\s\S]*?stagedPs1Path/,
  'setup ZIP route should zip a rendered temporary setup-node.ps1 instead of the tracked template file',
);

assert.deepEqual(
  agentsConfig,
  { agents: [] },
  'tracked agents.json should be public-safe and empty',
);
```

- [ ] **Step 2: Run the source-shape test and verify it fails**

Run:

```powershell
node test\agent-user-request-route.test.mjs
```

Expected: FAIL because `setup-node.ps1` still contains concrete defaults and the setup ZIP route does not render placeholders yet.

- [ ] **Step 3: Replace setup script defaults with placeholders**

In `setup-files/setup-node.ps1`, replace:

```powershell
    [string]$KeyVaultName = "committed-key-vault-name",
    [string]$SecretName = "committed-secret-name",
```

with:

```powershell
    [string]$KeyVaultName = "__RELAY_KEY_VAULT_NAME__",
    [string]$SecretName = "__RELAY_KEY_VAULT_SECRET_NAME__",
```

- [ ] **Step 4: Render setup script placeholders in the setup ZIP route**

In `app/api/nodes/setup/route.ts`, add these constants after `const SETUP_FILES_DIR = ...`:

```ts
const SETUP_KEY_VAULT_NAME_PLACEHOLDER = '__RELAY_KEY_VAULT_NAME__';
const SETUP_KEY_VAULT_SECRET_PLACEHOLDER = '__RELAY_KEY_VAULT_SECRET_NAME__';
```

Add these helper functions after the constants:

```ts
function escapePowerShellDoubleQuotedString(value: string): string {
  return value
    .replace(/`/g, '``')
    .replace(/\$/g, '`$')
    .replace(/"/g, '`"');
}

function renderSetupNodeScript(source: string): string {
  const keyVaultName = escapePowerShellDoubleQuotedString(process.env.RELAY_KEY_VAULT_NAME || '');
  const secretName = escapePowerShellDoubleQuotedString(process.env.RELAY_KEY_VAULT_SECRET_NAME || '');
  return source
    .replaceAll(SETUP_KEY_VAULT_NAME_PLACEHOLDER, keyVaultName)
    .replaceAll(SETUP_KEY_VAULT_SECRET_PLACEHOLDER, secretName);
}
```

Then replace the current ZIP creation logic:

```ts
    // Use PowerShell Compress-Archive (available on Windows)
    try { await fs.unlink(zipPath); } catch { /* ignore */ }
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${ps1Path}','${jsPath}' -DestinationPath '${zipPath}' -Force"`,
      { timeout: 10_000, windowsHide: true }
    );
```

with this rendered staging flow:

```ts
    const stagedPs1Path = path.join(tempDir, 'setup-node.ps1');
    const setupNodeScript = await fs.readFile(ps1Path, 'utf-8');

    // Use PowerShell Compress-Archive (available on Windows)
    try { await fs.unlink(zipPath); } catch { /* ignore */ }
    try { await fs.unlink(stagedPs1Path); } catch { /* ignore */ }
    await fs.writeFile(stagedPs1Path, renderSetupNodeScript(setupNodeScript), 'utf-8');
    execSync(
      `powershell -NoProfile -Command "Compress-Archive -Path '${stagedPs1Path}','${jsPath}' -DestinationPath '${zipPath}' -Force"`,
      { timeout: 10_000, windowsHide: true }
    );
```

After reading the zip buffer, replace the cleanup block:

```ts
    // Cleanup temp zip
    try { await fs.unlink(zipPath); } catch { /* ignore */ }
```

with:

```ts
    // Cleanup temporary setup artifacts
    try { await fs.unlink(zipPath); } catch { /* ignore */ }
    try { await fs.unlink(stagedPs1Path); } catch { /* ignore */ }
```

- [ ] **Step 5: Confirm `agents.json` is sanitized**

Ensure `agents.json` is exactly:

```json
{
  "agents": []
}
```

- [ ] **Step 6: Run the source-shape test and verify it passes**

Run:

```powershell
node test\agent-user-request-route.test.mjs
```

Expected: PASS with `agent user request route shape checks passed`.

- [ ] **Step 7: Commit setup templating**

Run:

```powershell
git add app\api\nodes\setup\route.ts setup-files\setup-node.ps1 test\agent-user-request-route.test.mjs agents.json
git commit -m "fix: template setup key vault defaults" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

---

### Task 2: Documentation and env example

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add failing documentation source checks**

In `test/agent-user-request-route.test.mjs`, add these constants near the other source constants:

```js
const envExampleSource = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const readmeSource = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
```

Before `console.log('agent user request route shape checks passed');`, add:

```js
assert.match(
  envExampleSource,
  /RELAY_KEY_VAULT_NAME=/,
  '.env.example should document RELAY_KEY_VAULT_NAME',
);

assert.match(
  envExampleSource,
  /RELAY_KEY_VAULT_SECRET_NAME=/,
  '.env.example should document RELAY_KEY_VAULT_SECRET_NAME',
);

assert.match(
  readmeSource,
  /RELAY_KEY_VAULT_NAME[\s\S]*Key Vault name used when generating the node setup ZIP/,
  'README should document RELAY_KEY_VAULT_NAME setup ZIP behavior',
);

assert.match(
  readmeSource,
  /RELAY_KEY_VAULT_SECRET_NAME[\s\S]*Key Vault secret name used when generating the node setup ZIP/,
  'README should document RELAY_KEY_VAULT_SECRET_NAME setup ZIP behavior',
);

assert.match(
  readmeSource,
  /download a new `copilot-node-setup\.zip` after changing these environment variables/,
  'README should explain that setup ZIPs are generated from current deployment env values',
);
```

- [ ] **Step 2: Run the source-shape test and verify it fails**

Run:

```powershell
node test\agent-user-request-route.test.mjs
```

Expected: FAIL because `.env.example` and README do not yet document the new variables.

- [ ] **Step 3: Update `.env.example`**

In `.env.example`, after `RELAY_SEND_CONNECTION_STRING=`, add:

```txt
# Key Vault defaults embedded into newly downloaded node setup ZIPs.
# Leave blank if you pass RELAY_CONNECTION_STRING directly to setup-node.ps1.
RELAY_KEY_VAULT_NAME=
RELAY_KEY_VAULT_SECRET_NAME=
```

Keep the existing relay discovery variables below that block.

- [ ] **Step 4: Update README env table**

In `README.md`, add two rows after `RELAY_SEND_CONNECTION_STRING` in the environment variable table:

```markdown
| `RELAY_KEY_VAULT_NAME` | Optional | Key Vault name used when generating the node setup ZIP |
| `RELAY_KEY_VAULT_SECRET_NAME` | Optional | Key Vault secret name used when generating the node setup ZIP |
```

- [ ] **Step 5: Update README setup-kit instructions**

In `README.md`, replace the first item under `#### Add a node with the setup kit` with:

```markdown
1. Configure Azure Relay variables in `.env.local` or deployment app settings:
   - `RELAY_SEND_CONNECTION_STRING` for server-side relay connections and node probing.
   - optionally `RELAY_KEY_VAULT_NAME` and `RELAY_KEY_VAULT_SECRET_NAME`; these values are embedded into newly downloaded setup ZIPs so the remote node can fetch `RELAY_CONNECTION_STRING` from Key Vault.
   - optionally `RELAY_SUBSCRIPTION_ID`, `RELAY_RESOURCE_GROUP`, and `RELAY_NAMESPACE` for auto-discovery.
   After changing setup ZIP environment values, restart or redeploy the app and download a new `copilot-node-setup.zip`.
```

- [ ] **Step 6: Run the source-shape test and verify it passes**

Run:

```powershell
node test\agent-user-request-route.test.mjs
```

Expected: PASS with `agent user request route shape checks passed`.

- [ ] **Step 7: Commit documentation**

Run:

```powershell
git add .env.example README.md test\agent-user-request-route.test.mjs
git commit -m "docs: document setup key vault env" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

Expected: commit succeeds.

---

### Task 3: Final validation

**Files:**
- Validate: `app/api/nodes/setup/route.ts`
- Validate: `setup-files/setup-node.ps1`
- Validate: `test/agent-user-request-route.test.mjs`
- Validate: `.env.example`
- Validate: `README.md`
- Validate: `agents.json`

- [ ] **Step 1: Run source-shape regression**

Run:

```powershell
node test\agent-user-request-route.test.mjs
```

Expected: PASS with `agent user request route shape checks passed`.

- [ ] **Step 2: Validate JSON config**

Run:

```powershell
node -e "const cfg=JSON.parse(require('fs').readFileSync('agents.json','utf8')); if (!Array.isArray(cfg.agents) || cfg.agents.length !== 0) process.exit(1); console.log('agents.json sanitized')"
```

Expected: PASS with `agents.json sanitized`.

- [ ] **Step 3: Run production build**

Run:

```powershell
npm run build
```

Expected: build exits successfully. If `next-env.d.ts` changes only because the build rewrote `.next` type paths, restore that generated change:

```powershell
git checkout-index -f -- next-env.d.ts
```

- [ ] **Step 4: Inspect final diff**

Run:

```powershell
git status --short
git --no-pager diff --stat origin/main...HEAD
```

Expected: working tree is clean except for intentionally uncommitted work only if the user has asked not to commit it. For this task, all implementation files should be committed and the working tree should be clean.

---

## Self-review checklist

- Spec coverage: Task 1 covers template placeholders, ZIP route replacement, temporary staging, and `agents.json` sanitization. Task 2 covers `.env.example` and README deployment instructions. Task 3 covers validation.
- Placeholder scan: plan text contains real placeholder names only where the implementation intentionally uses placeholders in `setup-node.ps1`.
- Type consistency: env names are consistently `RELAY_KEY_VAULT_NAME` and `RELAY_KEY_VAULT_SECRET_NAME`; setup script placeholders are consistently `__RELAY_KEY_VAULT_NAME__` and `__RELAY_KEY_VAULT_SECRET_NAME__`.
