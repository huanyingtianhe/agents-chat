// Relay listener: bridges Azure Relay Hybrid Connection to local copilot ACP TCP port
const WebSocket = require('hyco-ws');
const net = require('net');

const connectionString = process.env.RELAY_CONNECTION_STRING;
const connectionName = process.env.RELAY_CONNECTION_NAME || require('os').hostname().toLowerCase();
const acpPort = parseInt(process.env.ACP_PORT || '3001');

if (!connectionString) {
  console.error('RELAY_CONNECTION_STRING environment variable is required');
  process.exit(1);
}

console.log(`Relay listener starting...`);
console.log(`  Connection name: ${connectionName}`);
console.log(`  ACP port: ${acpPort}`);

const wss = WebSocket.createRelayedServer(
  { server: WebSocket.createRelayListenUri(
      connectionString.match(/Endpoint=sb:\/\/([^/;]+)/)[1],
      connectionName
    ),
    token: WebSocket.createRelayToken(
      WebSocket.createRelayListenUri(
        connectionString.match(/Endpoint=sb:\/\/([^/;]+)/)[1],
        connectionName
      ),
      connectionString.match(/SharedAccessKeyName=([^;]+)/)[1],
      connectionString.match(/SharedAccessKey=([^;]+)/)[1]
    )
  },
  (ws) => {
    console.log(`[${new Date().toLocaleTimeString()}] New relay connection, forwarding to localhost:${acpPort}`);

    const tcp = net.connect(acpPort, '127.0.0.1', () => {
      console.log(`[${new Date().toLocaleTimeString()}] TCP connected to copilot ACP`);
    });

    // Relay WebSocket → TCP
    ws.on('message', (data) => {
      tcp.write(data);
    });

    // TCP → Relay WebSocket
    tcp.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Cleanup
    ws.on('close', () => {
      console.log(`[${new Date().toLocaleTimeString()}] Relay connection closed`);
      tcp.destroy();
    });
    ws.on('error', (err) => {
      console.error(`WebSocket error: ${err.message}`);
      tcp.destroy();
    });
    tcp.on('close', () => {
      ws.close();
    });
    tcp.on('error', (err) => {
      console.error(`TCP error: ${err.message}`);
      ws.close();
    });
  }
);

wss.on('listening', () => {
  console.log(`Relay listener is ready. Waiting for connections via Azure Relay...`);
});

wss.on('error', (err) => {
  console.error(`Relay server error: ${err.message}`);
  process.exit(1);
});
