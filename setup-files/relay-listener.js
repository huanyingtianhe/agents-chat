// Relay listener: bridges Azure Relay Hybrid Connection to local copilot ACP TCP port
// Also intercepts fs/list_files, fs/read_text_file, fs/write_text_file for remote file browsing
const WebSocket = require('hyco-ws');
const net = require('net');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const connectionString = process.env.RELAY_CONNECTION_STRING;
const connectionName = process.env.RELAY_CONNECTION_NAME || require('os').hostname().toLowerCase();
const acpPort = parseInt(process.env.ACP_PORT || '3001');
const baseCwd = process.env.AGENT_CWD || process.cwd();

if (!connectionString) {
  console.error('RELAY_CONNECTION_STRING environment variable is required');
  process.exit(1);
}

console.log(`Relay listener starting...`);
console.log(`  Connection name: ${connectionName}`);
console.log(`  ACP port: ${acpPort}`);
console.log(`  Agent CWD: ${baseCwd}`);

const ns = connectionString.match(/Endpoint=sb:\/\/([^/;]+)/)[1];
const keyName = connectionString.match(/SharedAccessKeyName=([^;]+)/)[1];
const key = connectionString.match(/SharedAccessKey=([^;]+)/)[1];
const listenUri = WebSocket.createRelayListenUri(ns, connectionName);

/* ─── File system helpers (intercepted methods) ─── */

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage',
  '.data', '.cache', '__pycache__', '.venv', 'venv', 'vendor',
]);
const SKIP_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg', '.webp', '.tiff',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm', '.flac',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pyc', '.pyo', '.class', '.jar',
  '.db', '.sqlite', '.sqlite3',
  '.lock', '.map',
]);
const MAX_DEPTH = 8;

async function collectFiles(dir, rootCwd, depth, result) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = await fsPromises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(path.join(dir, entry.name), rootCwd, depth + 1, result);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXTENSIONS.has(ext)) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = await fsPromises.stat(fullPath);
        result.push({
          path: path.relative(rootCwd, fullPath).replace(/\\/g, '/'),
          name: entry.name,
          mtime: stat.mtime.toISOString(),
        });
      } catch { /* skip */ }
    }
  }
}

function resolveAndValidate(cwd, relativePath) {
  if (path.isAbsolute(relativePath)) return null;
  if (/^[a-zA-Z]:/.test(relativePath)) return null;
  if (relativePath.startsWith('\\\\') || relativePath.startsWith('//')) return null;
  const target = path.resolve(cwd, relativePath);
  const rel = path.relative(cwd, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}

async function handleFsListFiles(params) {
  const cwd = params.path || baseCwd;
  const diff = params.diff === true;

  if (diff) {
    try {
      const [diffResult, untrackedResult] = await Promise.all([
        execFileAsync('git', ['diff', '--name-only', 'HEAD'], { cwd }).catch(() => ({ stdout: '' })),
        execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd }).catch(() => ({ stdout: '' })),
      ]);
      const changedPaths = new Set(
        [...diffResult.stdout.split('\n'), ...untrackedResult.stdout.split('\n')]
          .map(l => l.trim()).filter(l => l.length > 0)
      );
      const files = [];
      for (const relPath of changedPaths) {
        const ext = path.extname(relPath).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;
        const fullPath = path.resolve(cwd, relPath);
        if (!fs.existsSync(fullPath)) continue;
        try {
          const stat = await fsPromises.stat(fullPath);
          if (!stat.isFile()) continue;
          files.push({ path: relPath.replace(/\\/g, '/'), name: path.basename(relPath), mtime: stat.mtime.toISOString() });
        } catch { /* skip */ }
      }
      files.sort((a, b) => a.path.localeCompare(b.path));
      return { files };
    } catch {
      return { error: 'git diff failed' };
    }
  }

  const files = [];
  await collectFiles(cwd, cwd, 0, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files };
}

async function handleFsReadTextFile(params) {
  const filePath = params.path;
  if (!filePath) return { error: 'missing path' };
  const target = resolveAndValidate(baseCwd, filePath);
  if (!target) return { error: 'invalid path' };
  if (!fs.existsSync(target)) return { error: 'file not found' };
  try {
    const content = await fsPromises.readFile(target, 'utf-8');
    const stat = await fsPromises.stat(target);
    const ext = path.extname(target).toLowerCase();
    const kind = ext === '.html' || ext === '.htm' ? 'html' : ext === '.md' ? 'markdown' : 'text';
    return { content, mtime: stat.mtime.toISOString(), kind };
  } catch {
    return { error: 'failed to read file' };
  }
}

async function handleFsWriteTextFile(params) {
  const filePath = params.path;
  const content = params.content;
  if (!filePath || content === undefined) return { error: 'missing path or content' };
  const target = resolveAndValidate(baseCwd, filePath);
  if (!target) return { error: 'invalid path' };

  // Optimistic concurrency
  if (params.mtime && fs.existsSync(target)) {
    const stat = await fsPromises.stat(target);
    if (stat.mtime.toISOString() !== params.mtime) {
      const serverContent = await fsPromises.readFile(target, 'utf-8');
      return { error: 'conflict', serverContent, serverMtime: stat.mtime.toISOString() };
    }
  }

  try {
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    await fsPromises.writeFile(target, content, 'utf-8');
    const stat = await fsPromises.stat(target);
    return { ok: true, mtime: stat.mtime.toISOString() };
  } catch {
    return { error: 'failed to write file' };
  }
}

// Methods intercepted by the relay-listener (not forwarded to ACP agent)
const INTERCEPTED_METHODS = new Set(['fs/list_files', 'fs/read_text_file', 'fs/write_text_file']);

async function handleIntercepted(method, params) {
  switch (method) {
    case 'fs/list_files': return handleFsListFiles(params || {});
    case 'fs/read_text_file': return handleFsReadTextFile(params || {});
    case 'fs/write_text_file': return handleFsWriteTextFile(params || {});
    default: return { error: 'unknown intercepted method' };
  }
}

/* ─── Main relay server ─── */

const wss = WebSocket.createRelayedServer(
  { server: listenUri,
    token: () => WebSocket.createRelayToken(listenUri, keyName, key)
  },
  (ws) => {
    console.log(`[${new Date().toLocaleTimeString()}] New relay connection, forwarding to localhost:${acpPort}`);

    const tcp = net.connect(acpPort, '127.0.0.1', () => {
      console.log(`[${new Date().toLocaleTimeString()}] TCP connected to copilot ACP`);
    });

    let wsBuf = '';

    // Relay WebSocket → TCP (with interception)
    ws.on('message', (data) => {
      wsBuf += data.toString();
      let nl;
      while ((nl = wsBuf.indexOf('\n')) >= 0) {
        const line = wsBuf.slice(0, nl).trim();
        wsBuf = wsBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { tcp.write(line + '\n'); continue; }

        // Intercept fs methods
        if (msg.method && msg.id != null && INTERCEPTED_METHODS.has(msg.method)) {
          console.log(`[${new Date().toLocaleTimeString()}] Intercepted: ${msg.method} (id=${msg.id})`);
          handleIntercepted(msg.method, msg.params).then(result => {
            const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n';
            if (ws.readyState === WebSocket.OPEN) ws.send(resp);
          }).catch(err => {
            const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: err.message } }) + '\n';
            if (ws.readyState === WebSocket.OPEN) ws.send(resp);
          });
        } else {
          // Pass through to ACP agent
          tcp.write(line + '\n');
        }
      }
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
