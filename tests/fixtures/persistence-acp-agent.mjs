import { createHash, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
const write = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    write({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (request.method === 'session/new') {
    write({ id: request.id, result: { sessionId: randomUUID() } });
  } else if (request.method === 'session/prompt') {
    const digest = createHash('sha256').update(JSON.stringify(request.params.prompt)).digest('hex');
    write({
      method: 'session/update',
      params: {
        sessionId: request.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Prompt digest: ${digest}` } },
      },
    });
    write({ id: request.id, result: { stopReason: 'end_turn' } });
  } else {
    write({ id: request.id, error: { code: -32601, message: `Unsupported fixture method: ${request.method}` } });
  }
});
input.on('close', () => process.exit(0));
