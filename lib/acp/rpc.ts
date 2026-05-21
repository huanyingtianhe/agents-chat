import type { ChildProcess } from 'child_process';
import type { NdjsonRpc, PendingRequest } from './types';

/* ─────────── Minimal NDJSON-RPC over raw Node streams ─────────── */

export function createNdjsonRpc(cp: ChildProcess): NdjsonRpc {
  let nextId = 0;
  const pending = new Map<number, PendingRequest>();
  let buf = '';

  const rpc: NdjsonRpc = {
    kind: 'local',
    onNotification: null,
    onRequest: null,
    onClose: null,

    send(method, params, timeoutMs?: number) {
      const id = ++nextId;
      const msg = JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n';
      console.log(`[ACP] → ${method} (id=${id})`);
      cp.stdin!.write(msg);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const ms = timeoutMs ?? (method === 'session/prompt' ? 0 : 120_000);
        if (ms > 0) {
          setTimeout(() => {
            if (pending.has(id)) {
              pending.delete(id);
              reject(new Error(`ACP timeout: ${method}`));
            }
          }, ms);
        }
      });
    },

    respond(id, result) {
      const msg = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
      cp.stdin!.write(msg);
    },

    writeRaw(line: string) {
      cp.stdin!.write(line + '\n');
    },

    destroy() {
      for (const p of pending.values()) p.reject(new Error('ACP destroyed'));
      pending.clear();
      try { cp.kill(); } catch { /* ignore */ }
    },
  };

  cp.stdout!.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      // Force a flat string copy to avoid V8 SlicedString retaining the original large buf
      if (buf.length > 0) buf = (' ' + buf).slice(1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if ('method' in msg && 'id' in msg && msg.id != null) {
          rpc.onRequest?.(msg.method, msg.params, msg.id);
        } else if ('method' in msg) {
          rpc.onNotification?.(msg.method, msg.params);
        } else if ('id' in msg) {
          const p = pending.get(msg.id);
          if (p) {
            pending.delete(msg.id);
            if (msg.error) {
              p.reject(new Error(JSON.stringify(msg.error)));
            } else {
              p.resolve(msg.result);
            }
          }
        }
      } catch { /* skip malformed lines */ }
    }
  });

  return rpc;
}

/* ─────────────── Relay NDJSON-RPC (Azure Relay WebSocket) ─────────────── */

const RELAY_SEND_CONNECTION_STRING = process.env.RELAY_SEND_CONNECTION_STRING || '';

export function createRelayNdjsonRpc(connectionName: string): Promise<NdjsonRpc> {
  // Dynamic import to keep hyco-ws out of client bundles
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const HycoWebSocket = require('hyco-ws');

  const ns = RELAY_SEND_CONNECTION_STRING.match(/Endpoint=sb:\/\/([^/;]+)/)?.[1];
  const keyName = RELAY_SEND_CONNECTION_STRING.match(/SharedAccessKeyName=([^;]+)/)?.[1];
  const key = RELAY_SEND_CONNECTION_STRING.match(/SharedAccessKey=([^;]+)/)?.[1];
  if (!ns || !keyName || !key) throw new Error('Invalid RELAY_SEND_CONNECTION_STRING');

  const uri = HycoWebSocket.createRelaySendUri(ns, connectionName);
  const token = HycoWebSocket.createRelayToken(uri, keyName, key);

  return new Promise((resolveRpc, rejectRpc) => {
    let nextId = 0;
    const pending = new Map<number, PendingRequest>();
    let buf = '';
    let connected = false;

    const ws = HycoWebSocket.relayedConnect(uri, token);

    function processBuffer() {
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (buf.length > 0) buf = (' ' + buf).slice(1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if ('method' in msg && 'id' in msg && msg.id != null) {
            rpc.onRequest?.(msg.method, msg.params, msg.id);
          } else if ('method' in msg) {
            rpc.onNotification?.(msg.method, msg.params);
          } else if ('id' in msg) {
            const p = pending.get(msg.id);
            if (p) {
              pending.delete(msg.id);
              if (msg.error) {
                p.reject(new Error(JSON.stringify(msg.error)));
              } else {
                p.resolve(msg.result);
              }
            }
          }
        } catch { /* skip malformed lines */ }
      }
    }

    const rpc: NdjsonRpc = {
      kind: 'relay',
      onNotification: null,
      onRequest: null,
      onClose: null,

      send(method, params, timeoutMs?: number) {
        const id = ++nextId;
        const msg = JSON.stringify({ jsonrpc: '2.0', method, id, params }) + '\n';
        console.log(`[ACP-RELAY] → ${method} (id=${id})`);
        ws.send(msg);
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          const ms = timeoutMs ?? (method === 'session/prompt' ? 0 : 120_000);
          if (ms > 0) {
            setTimeout(() => {
              if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`ACP relay timeout: ${method}`));
              }
            }, ms);
          }
        });
      },

      respond(id, result) {
        const msg = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
        ws.send(msg);
      },

      writeRaw(line: string) {
        ws.send(line + '\n');
      },

      destroy() {
        for (const p of pending.values()) p.reject(new Error('ACP relay destroyed'));
        pending.clear();
        try { ws.close(); } catch { /* ignore */ }
      },
    };

    ws.on('open', () => {
      connected = true;
      console.log(`[ACP-RELAY] Connected to ${connectionName}`);
      resolveRpc(rpc);
    });

    ws.on('message', (data: Buffer | string) => {
      buf += data.toString();
      processBuffer();
    });

    ws.on('close', () => {
      console.log(`[ACP-RELAY] Connection closed: ${connectionName}`);
      for (const p of pending.values()) p.reject(new Error('Relay connection closed'));
      pending.clear();
      rpc.onClose?.('connection closed');
    });

    ws.on('error', (err: Error) => {
      console.error(`[ACP-RELAY] Error: ${err.message}`);
      if (!connected) {
        rejectRpc(err);
      }
      for (const p of pending.values()) p.reject(new Error(`Relay error: ${err.message}`));
      pending.clear();
      rpc.onClose?.(`error: ${err.message}`);
    });
  });
}
