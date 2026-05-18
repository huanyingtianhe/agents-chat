/// <reference types="node" />

import { expect, test } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getNodeOwner, getNodeOwnerFromConnectionName, getNodeOwnerFromUserMetadata } from '../lib/nodeOwner';

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runAz(args: string[]): string {
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')",
    `& az ${args.map(quotePowerShellArg).join(' ')}`,
  ].join('; ');

  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf-8',
    timeout: 60_000,
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

const TEST_SUBSCRIPTION_ID = process.env.AZURE_NODE_OWNER_TEST_SUBSCRIPTION_ID || process.env.RELAY_SUBSCRIPTION_ID || readEnvFileValue('RELAY_SUBSCRIPTION_ID');
const TEST_RESOURCE_GROUP = process.env.AZURE_NODE_OWNER_TEST_RESOURCE_GROUP || process.env.RELAY_RESOURCE_GROUP || readEnvFileValue('RELAY_RESOURCE_GROUP');
const TEST_KEY_VAULT = process.env.AZURE_NODE_OWNER_TEST_KEY_VAULT || process.env.RELAY_KEY_VAULT_NAME || readEnvFileValue('RELAY_KEY_VAULT_NAME');
const TEST_SECRET_NAME = process.env.AZURE_NODE_OWNER_TEST_SECRET_NAME || process.env.RELAY_KEY_VAULT_SECRET_NAME || readEnvFileValue('RELAY_KEY_VAULT_SECRET_NAME');
const TEST_CONNECTION_NAME = process.env.AZURE_NODE_OWNER_TEST_CONNECTION || 'cpc-example-cksvl';
const TEST_EXPECTED_OWNER = process.env.AZURE_NODE_OWNER_TEST_OWNER || 'example@microsoft.com';

function resolveRelayNamespace(): string {
  const configuredNamespace = process.env.RELAY_NAMESPACE || readEnvFileValue('RELAY_NAMESPACE');
  if (configuredNamespace) return configuredNamespace;

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

test.describe('node owner metadata', () => {
  test('extracts AzureAccountEmail from Hybrid Connection user metadata', () => {
    const owner = getNodeOwnerFromUserMetadata('AzureAccountEmail=example@microsoft.com');

    expect(owner).toBe('example@microsoft.com');
  });

  test('extracts AzureAccountEmail when other metadata entries exist', () => {
    const owner = getNodeOwnerFromUserMetadata('Environment=dev; AzureAccountEmail=Example@Microsoft.com; Region=westus');

    expect(owner).toBe('example@microsoft.com');
  });

  test('falls back to connection name when AzureAccountEmail metadata is missing', () => {
    expect(getNodeOwnerFromConnectionName('cpc-example-cksvl')).toBe('example@microsoft.com');
    expect(getNodeOwner('', 'cpc-example-cksvl')).toBe('example@microsoft.com');
  });

  test('prefers AzureAccountEmail metadata over connection name fallback', () => {
    const owner = getNodeOwner('AzureAccountEmail=owner@microsoft.com', 'cpc-example-cksvl');

    expect(owner).toBe('owner@microsoft.com');
  });

  test('finds owner from a real Azure Hybrid Connection', () => {
    test.skip(process.env.RUN_AZURE_NODE_OWNER_TEST !== '1', 'Set RUN_AZURE_NODE_OWNER_TEST=1 to query Azure.');
    test.skip(!TEST_SUBSCRIPTION_ID || !TEST_RESOURCE_GROUP || !TEST_KEY_VAULT || !TEST_SECRET_NAME, 'Set Azure relay test configuration environment variables.');

    const namespaceName = resolveRelayNamespace();
    expect(namespaceName).toBeTruthy();

    const userMetadata = runAz([
      'relay', 'hyco', 'show',
      '--subscription', TEST_SUBSCRIPTION_ID,
      '--resource-group', TEST_RESOURCE_GROUP,
      '--namespace-name', namespaceName,
      '--name', TEST_CONNECTION_NAME,
      '--query', 'userMetadata',
      '-o', 'tsv',
    ]);

    expect(userMetadata).toContain('AzureAccountEmail=');
    expect(getNodeOwner(userMetadata, TEST_CONNECTION_NAME)).toBe(TEST_EXPECTED_OWNER);
  });
});
