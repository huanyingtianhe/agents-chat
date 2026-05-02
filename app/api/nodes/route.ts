import { NextRequest, NextResponse } from 'next/server';
import * as path from 'path';
import * as fs from 'fs/promises';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NODES_CONFIG_PATH = path.join(process.cwd(), 'nodes.json');

const RELAY_SEND_CONNECTION_STRING = process.env.RELAY_SEND_CONNECTION_STRING || '';
const RELAY_SUBSCRIPTION_ID = process.env.RELAY_SUBSCRIPTION_ID || '';
const RELAY_RESOURCE_GROUP = process.env.RELAY_RESOURCE_GROUP || '';
const RELAY_NAMESPACE = process.env.RELAY_NAMESPACE || '';

type NodeConfig = {
  name: string;
  label: string;
  manual?: boolean; // true if added manually via nodes.json
};

type NodeStatus = NodeConfig & {
  online: boolean;
  checkedAt: number;
};

// Cache probe results for 30s to avoid hammering relay
const probeCache = new Map<string, { online: boolean; ts: number }>();
const PROBE_TTL_MS = 30_000;

// Cache discovered hybrid connections for 60s
let discoveryCache: { names: string[]; ts: number } | null = null;
const DISCOVERY_TTL_MS = 60_000;

async function readNodesConfig(): Promise<NodeConfig[]> {
  try {
    const raw = await fs.readFile(NODES_CONFIG_PATH, 'utf-8');
    const data = JSON.parse(raw);
    return ((data.nodes || []) as NodeConfig[]).map(n => ({ ...n, manual: true }));
  } catch {
    return [];
  }
}

async function writeNodesConfig(nodes: NodeConfig[]): Promise<void> {
  // Only persist manual nodes
  const manual = nodes.filter(n => n.manual).map(({ name, label }) => ({ name, label }));
  await fs.writeFile(NODES_CONFIG_PATH, JSON.stringify({ nodes: manual }, null, 2), 'utf-8');
}

/**
 * Discover hybrid connections from the Azure Relay namespace via ARM REST API.
 * Uses `az account get-access-token` to get a management token.
 */
async function discoverHybridConnections(): Promise<string[]> {
  if (!RELAY_SUBSCRIPTION_ID || !RELAY_RESOURCE_GROUP || !RELAY_NAMESPACE) return [];

  if (discoveryCache && Date.now() - discoveryCache.ts < DISCOVERY_TTL_MS) {
    return discoveryCache.names;
  }

  try {
    const { execSync } = require('child_process');
    const tokenJson = execSync('az account get-access-token --resource https://management.azure.com/ -o json', {
      encoding: 'utf-8', timeout: 15_000, windowsHide: true,
    });
    const { accessToken } = JSON.parse(tokenJson);

    const url = `https://management.azure.com/subscriptions/${RELAY_SUBSCRIPTION_ID}/resourceGroups/${RELAY_RESOURCE_GROUP}/providers/Microsoft.Relay/namespaces/${RELAY_NAMESPACE}/hybridConnections?api-version=2021-11-01`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      console.error(`[Nodes] ARM API error: ${res.status} ${res.statusText}`);
      return discoveryCache?.names || [];
    }

    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names: string[] = (data.value || []).map((hc: any) => hc.name as string);
    discoveryCache = { names, ts: Date.now() };
    return names;
  } catch (err) {
    console.error('[Nodes] Discovery failed:', err);
    return discoveryCache?.names || [];
  }
}

/**
 * Merge auto-discovered nodes with manual nodes.
 * Manual nodes take priority for labels.
 */
async function getAllNodes(): Promise<NodeConfig[]> {
  const [manualNodes, discoveredNames] = await Promise.all([
    readNodesConfig(),
    discoverHybridConnections(),
  ]);

  const manualMap = new Map(manualNodes.map(n => [n.name, n]));
  const merged: NodeConfig[] = [];

  // Add all discovered nodes (use manual label if available)
  for (const name of discoveredNames) {
    const manual = manualMap.get(name);
    merged.push({
      name,
      label: manual?.label || name,
      manual: !!manual,
    });
    manualMap.delete(name);
  }

  // Add any manual nodes not found in discovery (e.g. namespace not yet synced)
  for (const node of manualMap.values()) {
    merged.push(node);
  }

  return merged;
}

/**
 * Probe a relay hybrid connection to check if a listener is active.
 */
async function probeNode(connectionName: string): Promise<boolean> {
  const cached = probeCache.get(connectionName);
  if (cached && Date.now() - cached.ts < PROBE_TTL_MS) return cached.online;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const HycoWebSocket = require('hyco-ws');

    const ns = RELAY_SEND_CONNECTION_STRING.match(/Endpoint=sb:\/\/([^/;]+)/)?.[1];
    const keyName = RELAY_SEND_CONNECTION_STRING.match(/SharedAccessKeyName=([^;]+)/)?.[1];
    const key = RELAY_SEND_CONNECTION_STRING.match(/SharedAccessKey=([^;]+)/)?.[1];
    if (!ns || !keyName || !key) throw new Error('Invalid RELAY_SEND_CONNECTION_STRING');

    const uri = HycoWebSocket.createRelaySendUri(ns, connectionName);
    const token = HycoWebSocket.createRelayToken(uri, keyName, key);

    const online = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        resolve(false);
      }, 5_000);

      const ws = HycoWebSocket.connect(uri, token);

      ws.on('open', () => {
        clearTimeout(timeout);
        try { ws.close(); } catch { /* ignore */ }
        resolve(true);
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });

      ws.on('close', () => {
        clearTimeout(timeout);
      });
    });

    probeCache.set(connectionName, { online, ts: Date.now() });
    return online;
  } catch {
    probeCache.set(connectionName, { online: false, ts: Date.now() });
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;

    if (action === 'list-nodes') {
      const nodes = await getAllNodes();
      const statuses: NodeStatus[] = await Promise.all(
        nodes.map(async (node) => ({
          ...node,
          online: await probeNode(node.name),
          checkedAt: Date.now(),
        }))
      );
      return NextResponse.json({ ok: true, nodes: statuses });
    }

    if (action === 'check-node') {
      const { name } = body;
      if (!name) return NextResponse.json({ ok: false, error: 'missing name' }, { status: 400 });
      probeCache.delete(name);
      const online = await probeNode(name);
      return NextResponse.json({ ok: true, name, online, checkedAt: Date.now() });
    }

    if (action === 'add-node') {
      const { name, label } = body;
      if (!name) return NextResponse.json({ ok: false, error: 'missing name' }, { status: 400 });
      const nodes = await readNodesConfig();
      if (nodes.some(n => n.name === name)) {
        return NextResponse.json({ ok: false, error: 'node already exists' }, { status: 409 });
      }
      nodes.push({ name, label: label || name, manual: true });
      await writeNodesConfig(nodes);
      return NextResponse.json({ ok: true });
    }

    if (action === 'remove-node') {
      const { name } = body;
      if (!name) return NextResponse.json({ ok: false, error: 'missing name' }, { status: 400 });
      const nodes = await readNodesConfig();
      const filtered = nodes.filter(n => n.name !== name);
      if (filtered.length === nodes.length) {
        return NextResponse.json({ ok: false, error: 'node not found' }, { status: 404 });
      }
      await writeNodesConfig(filtered);
      probeCache.delete(name);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
  } catch (err) {
    console.error('[Nodes API]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
