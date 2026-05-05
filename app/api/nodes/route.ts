import { NextRequest, NextResponse } from 'next/server';
import { isAdminToken, getUserEmail, canModify, getAuthToken } from '@/lib/auth';
import * as configStore from '@/lib/configStore';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RELAY_SEND_CONNECTION_STRING = process.env.RELAY_SEND_CONNECTION_STRING || '';
const RELAY_SUBSCRIPTION_ID = process.env.RELAY_SUBSCRIPTION_ID || '';
const RELAY_RESOURCE_GROUP = process.env.RELAY_RESOURCE_GROUP || '';
const RELAY_NAMESPACE = process.env.RELAY_NAMESPACE || '';

type NodeStatus = {
  name: string;
  label: string;
  owner: string;
  canModify: boolean;
  manual: boolean;
  online: boolean;
  checkedAt: number;
};

// Cache probe results for 30s to avoid hammering relay
const probeCache = new Map<string, { online: boolean; ts: number }>();
const PROBE_TTL_MS = 30_000;

// Cache discovered hybrid connections for 60s
type DiscoveredNode = { name: string; createdBy: string };
let discoveryCache: { nodes: DiscoveredNode[]; ts: number } | null = null;
const DISCOVERY_TTL_MS = 60_000;

/**
 * Discover hybrid connections from the Azure Relay namespace via ARM REST API.
 * Uses `az account get-access-token` to get a management token.
 * Returns name and createdBy (from systemData) for each connection.
 */
async function discoverHybridConnections(): Promise<DiscoveredNode[]> {
  if (!RELAY_SUBSCRIPTION_ID || !RELAY_RESOURCE_GROUP || !RELAY_NAMESPACE) return [];

  if (discoveryCache && Date.now() - discoveryCache.ts < DISCOVERY_TTL_MS) {
    return discoveryCache.nodes;
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
      return discoveryCache?.nodes || [];
    }

    const data = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes: DiscoveredNode[] = (data.value || []).map((hc: any) => {
      const name = hc.name as string;
      // Try systemData.createdBy first, then extract alias from name pattern: cpc-{alias}-{suffix}
      let createdBy = (hc.systemData?.createdBy as string) || '';
      if (!createdBy) {
        const parts = name.split('-');
        if (parts.length >= 3 && parts[0] === 'cpc') {
          createdBy = `${parts[1]}@microsoft.com`;
        }
      }
      return { name, createdBy };
    });
    discoveryCache = { nodes, ts: Date.now() };
    return nodes;
  } catch (err) {
    console.error('[Nodes] Discovery failed:', err);
    return discoveryCache?.nodes || [];
  }
}

/**
 * Merge auto-discovered nodes with manual nodes from SQLite.
 * Newly discovered nodes are persisted to SQLite with owner from systemData.createdBy.
 */
type MergedNode = { name: string; label: string; owner: string; manual: boolean };

async function getAllMergedNodes(): Promise<MergedNode[]> {
  const discoveredNodes = await discoverHybridConnections();

  // Persist any newly discovered nodes to SQLite, update 'system' owners if we now have a real one
  for (const disc of discoveredNodes) {
    const existing = configStore.getNodeByName(disc.name);
    if (!existing) {
      configStore.createNode({
        name: disc.name,
        label: disc.name,
        owner: disc.createdBy || 'system',
      });
    } else if (existing.owner === 'system' && disc.createdBy && disc.createdBy !== 'system') {
      // Update owner if we now have a real creator and the current owner is just the default
      configStore.updateNode(disc.name, { owner: disc.createdBy });
    }
  }

  // Return all nodes from SQLite (includes both manually created and auto-persisted)
  const allNodes = configStore.getAllNodes();
  const discoveredNames = new Set(discoveredNodes.map(d => d.name));

  return allNodes.map(node => ({
    name: node.name,
    label: node.label,
    owner: node.owner,
    manual: !discoveredNames.has(node.name),
  }));
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
    console.log('[probeNode]', connectionName, 'uri:', uri, 'keyName:', keyName);

    const online = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        console.log('[probeNode]', connectionName, 'TIMEOUT');
        try { ws.close(); } catch { /* ignore */ }
        resolve(false);
      }, 5_000);

      // Use relayedConnect which passes token via ServiceBusAuthorization header
      const ws = HycoWebSocket.relayedConnect(uri, token);

      ws.on('open', () => {
        console.log('[probeNode]', connectionName, 'OPEN');
        clearTimeout(timeout);
        try { ws.close(); } catch { /* ignore */ }
        resolve(true);
      });

      ws.on('error', (err: Error) => {
        console.log('[probeNode]', connectionName, 'ERROR:', err?.message);
        clearTimeout(timeout);
        resolve(false);
      });

      ws.on('close', () => {
        clearTimeout(timeout);
      });
    });

    console.log('[probeNode]', connectionName, 'result:', online);
    probeCache.set(connectionName, { online, ts: Date.now() });
    return online;
  } catch (err) {
    console.log('[probeNode]', connectionName, 'CATCH:', err);
    probeCache.set(connectionName, { online: false, ts: Date.now() });
    return false;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action } = body;
    const token = await getAuthToken(req);

    if (action === 'list-nodes') {
      const nodes = await getAllMergedNodes();
      const statuses: NodeStatus[] = await Promise.all(
        nodes.map(async (node) => ({
          name: node.name,
          label: node.label,
          owner: node.owner,
          canModify: canModify(token, node.owner),
          manual: node.manual,
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
      const ownerEmail = getUserEmail(token);
      if (!ownerEmail) {
        return NextResponse.json({ ok: false, error: 'email_required_for_ownership' }, { status: 400 });
      }

      const { name, label } = body;
      if (!name) return NextResponse.json({ ok: false, error: 'missing name' }, { status: 400 });
      const existing = configStore.getNodeByName(name);
      if (existing) {
        return NextResponse.json({ ok: false, error: 'node already exists' }, { status: 409 });
      }
      configStore.createNode({ name, label: label || name, owner: ownerEmail });
      return NextResponse.json({ ok: true });
    }

    if (action === 'update-node') {
      const { name, label } = body;
      if (!name) return NextResponse.json({ ok: false, error: 'missing name' }, { status: 400 });
      const nodeRecord = configStore.getNodeByName(name);
      if (!nodeRecord) return NextResponse.json({ ok: false, error: 'node not found' }, { status: 404 });
      if (!canModify(token, nodeRecord.owner)) {
        return NextResponse.json({ ok: false, error: 'permission_denied' }, { status: 403 });
      }
      configStore.updateNode(name, { label });
      return NextResponse.json({ ok: true });
    }

    if (action === 'remove-node') {
      const { name } = body;
      if (!name) return NextResponse.json({ ok: false, error: 'missing name' }, { status: 400 });

      // Check permissions: manual nodes require owner/admin; discovered-only nodes require admin
      const nodeRecord = configStore.getNodeByName(name);
      if (nodeRecord) {
        if (!canModify(token, nodeRecord.owner)) {
          return NextResponse.json({ ok: false, error: 'permission_denied' }, { status: 403 });
        }
        configStore.deleteNode(name);
      } else {
        // Discovered-only node (not in SQLite) — admin-only to delete from Azure
        if (!isAdminToken(token)) {
          return NextResponse.json({ ok: false, error: 'admin_only_for_discovered_nodes' }, { status: 403 });
        }
      }

      // Delete the hybrid connection from Azure Relay namespace
      if (RELAY_SUBSCRIPTION_ID && RELAY_RESOURCE_GROUP && RELAY_NAMESPACE) {
        try {
          const { execSync } = require('child_process');
          const tokenJson = execSync('az account get-access-token --resource https://management.azure.com/ -o json', {
            encoding: 'utf-8', timeout: 15_000, windowsHide: true,
          });
          const { accessToken } = JSON.parse(tokenJson);

          const url = `https://management.azure.com/subscriptions/${RELAY_SUBSCRIPTION_ID}/resourceGroups/${RELAY_RESOURCE_GROUP}/providers/Microsoft.Relay/namespaces/${RELAY_NAMESPACE}/hybridConnections/${encodeURIComponent(name)}?api-version=2021-11-01`;
          const res = await fetch(url, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${accessToken}` },
          });

          if (!res.ok && res.status !== 404) {
            console.error(`[Nodes] Failed to delete hybrid connection ${name}: ${res.status} ${res.statusText}`);
            return NextResponse.json({ ok: false, error: `Azure delete failed: ${res.status}` }, { status: 500 });
          }
        } catch (err) {
          console.error(`[Nodes] Error deleting hybrid connection ${name}:`, err);
          return NextResponse.json({ ok: false, error: `Azure delete error: ${err}` }, { status: 500 });
        }
      }

      // Clear caches
      probeCache.delete(name);
      discoveryCache = null;
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'unknown action' }, { status: 400 });
  } catch (err) {
    console.error('[Nodes API]', err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
