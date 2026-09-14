import type { NodeProbeState } from './nodeTypes';

type RelaySocket = {
  close(): void;
  on(event: 'open' | 'close', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
};

export type RelayWebSocketApi = {
  createRelaySendUri: (namespace: string, connectionName: string) => string;
  createRelayToken: (uri: string, keyName: string, key: string) => string;
  relayedConnect: (uri: string, token: string) => RelaySocket;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function probeRelayNode(
  connectionName: string,
  connectionString: string,
  relay: RelayWebSocketApi,
  timeoutMs = 5_000,
): Promise<NodeProbeState> {
  const checkedAt = Date.now();
  try {
    const namespace = connectionString.match(/Endpoint=sb:\/\/([^/;]+)/)?.[1];
    const keyName = connectionString.match(/SharedAccessKeyName=([^;]+)/)?.[1];
    const key = connectionString.match(/SharedAccessKey=([^;]+)/)?.[1];
    if (!namespace || !keyName || !key) throw new Error('Invalid RELAY_SEND_CONNECTION_STRING');

    const uri = relay.createRelaySendUri(namespace, connectionName);
    const token = relay.createRelayToken(uri, keyName, key);
    const result = await new Promise<Omit<NodeProbeState, 'checkedAt'>>((resolve) => {
      let settled = false;
      let socket: RelaySocket | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (online: boolean, connectionError: string | null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        try { socket?.close(); } catch { /* ignore close failures after a completed probe */ }
        resolve({ online, platform: null, connectionError });
      };

      try {
        socket = relay.relayedConnect(uri, token);
      } catch (error) {
        finish(false, errorMessage(error));
        return;
      }
      socket.on('open', () => finish(true, null));
      socket.on('error', (error) => finish(false, error?.message || 'Relay connection failed'));
      socket.on('close', () => finish(false, 'Relay connection closed before opening'));
      timeout = setTimeout(
        () => finish(false, `Relay connection timed out after ${timeoutMs}ms`),
        timeoutMs,
      );
    });
    return { ...result, checkedAt };
  } catch (error) {
    return {
      online: false,
      checkedAt,
      platform: null,
      connectionError: errorMessage(error),
    };
  }
}
