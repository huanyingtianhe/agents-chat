import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { nodesApi } from '../app/features/nodes/nodesApi';
import { probeRelayNode, type RelayWebSocketApi } from '../lib/nodes/nodeProbe';

const CONNECTION_STRING = 'Endpoint=sb://relay.example/;SharedAccessKeyName=send;SharedAccessKey=secret';

function relayThat(emits: 'open' | 'error' | 'close'): RelayWebSocketApi {
  return {
    createRelaySendUri: (_namespace, connectionName) => `wss://relay.example/${connectionName}`,
    createRelayToken: () => 'token',
    relayedConnect: () => {
      const socket = new EventEmitter() as EventEmitter & { close: () => void };
      socket.close = () => {};
      queueMicrotask(() => {
        if (emits === 'error') socket.emit('error', new Error('Relay listener refused connection'));
        else socket.emit(emits);
      });
      return socket;
    },
  };
}

test('relay probe returns truthful nullable platform and no error when online', async () => {
  const result = await probeRelayNode('online-node', CONNECTION_STRING, relayThat('open'), 50);

  assert.equal(result.online, true);
  assert.equal(result.platform, null);
  assert.equal(result.connectionError, null);
  assert.equal(typeof result.checkedAt, 'number');
});

test('relay probe preserves the actual connection failure', async () => {
  const result = await probeRelayNode('offline-node', CONNECTION_STRING, relayThat('error'), 50);

  assert.equal(result.online, false);
  assert.equal(result.platform, null);
  assert.equal(result.connectionError, 'Relay listener refused connection');
});

test('relay probe reports unsupported configuration instead of inventing status', async () => {
  const result = await probeRelayNode('unknown-node', '', relayThat('open'), 50);

  assert.equal(result.online, false);
  assert.equal(result.platform, null);
  assert.equal(result.connectionError, 'Invalid RELAY_SEND_CONNECTION_STRING');
});

test('nodes API client prefers a JSON error message', async () => {
  await assert.rejects(
    nodesApi(
      { action: 'list-nodes' },
      async () => new Response(JSON.stringify({ ok: false, error: 'Nodes unavailable' }), { status: 503 }),
    ),
    /Nodes unavailable/,
  );
});

test('nodes API client preserves a non-JSON error body', async () => {
  await assert.rejects(
    nodesApi(
      { action: 'list-nodes' },
      async () => new Response('Relay gateway unavailable', { status: 502 }),
    ),
    /Relay gateway unavailable/,
  );
});

test('nodes API client falls back to the response status for an empty error', async () => {
  await assert.rejects(
    nodesApi(
      { action: 'list-nodes' },
      async () => new Response(null, { status: 504 }),
    ),
    /Nodes request failed \(504\)/,
  );
});
