/// <reference types="node" />

import { expect, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getNodeOwner } from '../lib/nodeOwner';

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPowerShell(command: string, timeout = 60_000): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf-8',
    timeout,
    windowsHide: true,
  }).trim();
}

function runPowerShellFile(filePath: string, args: string[], cwd: string, timeout = 600_000): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', filePath, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout,
    windowsHide: true,
  }).trim();
}

function readEnvFileValue(name: string): string {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return '';

  const line = fs.readFileSync(envPath, 'utf-8')
    .split(/\r?\n/)
    .find((entry: string) => entry.startsWith(`${name}=`));
  return line?.replace(`${name}=`, '').replace(/^"|"$/g, '').trim() || '';
}

const TEST_SUBSCRIPTION_ID = process.env.SETUP_NODE_TEST_SUBSCRIPTION_ID || process.env.RELAY_SUBSCRIPTION_ID || readEnvFileValue('RELAY_SUBSCRIPTION_ID');
const TEST_RESOURCE_GROUP = process.env.SETUP_NODE_TEST_RESOURCE_GROUP || process.env.RELAY_RESOURCE_GROUP || readEnvFileValue('RELAY_RESOURCE_GROUP');
const TEST_KEY_VAULT = process.env.SETUP_NODE_TEST_KEY_VAULT || process.env.RELAY_KEY_VAULT_NAME || readEnvFileValue('RELAY_KEY_VAULT_NAME');
const TEST_SECRET_NAME = process.env.SETUP_NODE_TEST_SECRET_NAME || process.env.RELAY_KEY_VAULT_SECRET_NAME || readEnvFileValue('RELAY_KEY_VAULT_SECRET_NAME');
const DEFAULT_TEST_CONNECTION = `cpc-setup-test-${Date.now().toString(36)}`;

function runAz(args: string[], timeout = 60_000): string {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')",
    "if (Test-Path 'C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin') { $env:Path += ';C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin' }",
    "if (Test-Path 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin') { $env:Path += ';C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin' }",
    `& az ${args.map(quotePowerShellArg).join(' ')}`,
  ].join('; ');
  return runPowerShell(command, timeout);
}

function isAdministrator(): boolean {
  const output = runPowerShell("$identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=[Security.Principal.WindowsPrincipal]::new($identity); $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
  return output.trim().toLowerCase() === 'true';
}

function resolveRelayNamespace(): string {
  const relayConnectionString = runAz([
    'keyvault', 'secret', 'show',
    '--vault-name', TEST_KEY_VAULT,
    '--name', TEST_SECRET_NAME,
    '--query', 'value',
    '-o', 'tsv',
  ]);
  const match = relayConnectionString.match(/Endpoint=sb:\/\/([^.]+)\./);
  return match?.[1] || '';
}

function getAzureAccountEmail(): string {
  return runAz(['account', 'show', '--query', 'user.name', '-o', 'tsv']).trim().toLowerCase();
}

function getHybridConnectionMetadata(namespaceName: string, connectionName: string): string {
  return runAz([
    'relay', 'hyco', 'show',
    '--subscription', TEST_SUBSCRIPTION_ID,
    '--resource-group', TEST_RESOURCE_GROUP,
    '--namespace-name', namespaceName,
    '--name', connectionName,
    '--query', 'userMetadata',
    '-o', 'tsv',
  ]);
}

function hybridConnectionExists(namespaceName: string, connectionName: string): boolean {
  const command = [
    "$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')",
    "if (Test-Path 'C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin') { $env:Path += ';C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin' }",
    "if (Test-Path 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin') { $env:Path += ';C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin' }",
    `& az ${[
      'relay', 'hyco', 'show',
      '--subscription', TEST_SUBSCRIPTION_ID,
      '--resource-group', TEST_RESOURCE_GROUP,
      '--namespace-name', namespaceName,
      '--name', connectionName,
      '--query', 'name',
      '-o', 'tsv',
    ].map(quotePowerShellArg).join(' ')} 1>$null 2>$null`,
    "if ($LASTEXITCODE -eq 0) { 'true' } else { 'false' }",
  ].join('; ');

  return runPowerShell(command).trim().toLowerCase() === 'true';
}

async function waitForHybridConnectionDeleted(namespaceName: string, connectionName: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (!hybridConnectionExists(namespaceName, connectionName)) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Hybrid Connection still exists after uninstall: ${connectionName}`);
}

test.describe('setup-node.ps1 integration', () => {
  test('installs service, exposes listener metadata, then uninstalls cleanly', async () => {
    test.setTimeout(900_000);
    test.skip(process.env.RUN_SETUP_NODE_TEST !== '1', 'Set RUN_SETUP_NODE_TEST=1 to install/uninstall the local node service.');
    test.skip(!TEST_SUBSCRIPTION_ID || !TEST_RESOURCE_GROUP || !TEST_KEY_VAULT || !TEST_SECRET_NAME, 'Set Azure relay setup test configuration environment variables.');
    test.skip(!isAdministrator(), 'setup-node.ps1 integration test requires Administrator PowerShell.');

    const repoRoot = process.cwd();
    const setupDir = path.join(repoRoot, 'setup-files');
    const setupScript = path.join(setupDir, 'setup-node.ps1');
    const logsDir = path.join(setupDir, 'logs');
    const serviceLog = path.join(logsDir, 'service.log');
    const relayLog = path.join(logsDir, 'relay.log');
    const connectionName = process.env.SETUP_NODE_TEST_CONNECTION || DEFAULT_TEST_CONNECTION;
    const namespaceName = resolveRelayNamespace();
    const expectedOwner = getAzureAccountEmail();

    expect(namespaceName).toBeTruthy();
    expect(expectedOwner).toContain('@');

    try {
      const setupArgs = [
        '-ConnectionName', connectionName,
        '-KeyVaultName', TEST_KEY_VAULT,
        '-SecretName', TEST_SECRET_NAME,
        '-RelaySubscriptionId', TEST_SUBSCRIPTION_ID,
        '-RelayResourceGroup', TEST_RESOURCE_GROUP,
      ];
      const setupOutput = runPowerShellFile(setupScript, setupArgs, setupDir, 900_000);
      expect(setupOutput).toContain('ACP server and relay listener are ready.');

      const serviceLogText = fs.readFileSync(serviceLog, 'utf-8');
      expect(serviceLogText).toContain(`Connection Name: ${connectionName}`);
      expect(serviceLogText).toContain('=== Running ===');

      const relayLogText = fs.readFileSync(relayLog, 'utf-8');
      expect(relayLogText).toContain(`Connection name: ${connectionName}`);
      expect(relayLogText).toContain('Relay listener is ready');

      const metadata = getHybridConnectionMetadata(namespaceName, connectionName);
      expect(metadata).toContain(`AzureAccountEmail=${expectedOwner}`);
      expect(getNodeOwner(metadata, connectionName)).toBe(expectedOwner);
    } finally {
      runPowerShellFile(setupScript, [
        '-UninstallService',
        '-ConnectionName', connectionName,
        '-KeyVaultName', TEST_KEY_VAULT,
        '-SecretName', TEST_SECRET_NAME,
        '-RelaySubscriptionId', TEST_SUBSCRIPTION_ID,
        '-RelayResourceGroup', TEST_RESOURCE_GROUP,
      ], setupDir, 300_000);
    }

    await waitForHybridConnectionDeleted(namespaceName, connectionName);
    expect(hybridConnectionExists(namespaceName, connectionName)).toBe(false);
  });
});
