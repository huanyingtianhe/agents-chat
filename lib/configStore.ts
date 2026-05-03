import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

/**
 * Server-side config storage for agents and nodes — SQLite backend.
 * Single file: .data/config.db
 */

const DATA_DIR = path.join(process.cwd(), '.data');
const DB_PATH = path.join(DATA_DIR, 'config.db');
const AGENTS_JSON_PATH = path.join(process.cwd(), 'agents.json');
const NODES_JSON_PATH = path.join(process.cwd(), 'nodes.json');

// ─── Types ───

export type AgentRecord = {
  id: string;
  name: string;
  command: string;
  args: string[];
  cwd: string;
  yolo: boolean;
  noTools: boolean;
  relay: boolean;
  relayConnectionName: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
};

export type NodeRecord = {
  name: string;
  label: string;
  owner: string;
  createdAt: string;
  updatedAt: string;
};

// ─── DB Initialization ───

let _db: ReturnType<typeof Database> | null = null;

function getDb(): ReturnType<typeof Database> {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      key TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      command TEXT NOT NULL DEFAULT 'copilot.exe',
      args TEXT NOT NULL DEFAULT '[]',
      cwd TEXT NOT NULL DEFAULT '',
      yolo INTEGER NOT NULL DEFAULT 1,
      no_tools INTEGER NOT NULL DEFAULT 0,
      relay INTEGER NOT NULL DEFAULT 0,
      relay_connection_name TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS nodes (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  runMigrations();
  return _db;
}

// ─── Migration from JSON files ───

function runMigrations(): void {
  const db = _db!;

  // Migrate agents.json
  const agentsMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('agents_json_import');
  if (!agentsMigrated) {
    try {
      const raw = fs.readFileSync(AGENTS_JSON_PATH, 'utf-8');
      const data = JSON.parse(raw);
      const agents = (data.agents || []) as any[];
      const defaultOwner = getDefaultOwner();

      const insert = db.prepare(`
        INSERT OR IGNORE INTO agents (id, name, command, args, cwd, yolo, no_tools, relay, relay_connection_name, owner)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const tx = db.transaction(() => {
        for (const a of agents) {
          insert.run(
            a.id,
            a.name || a.id,
            a.command || 'copilot.exe',
            JSON.stringify(a.args || []),
            a.cwd || '',
            a.yolo ? 1 : 0,
            a.noTools ? 1 : 0,
            a.relay ? 1 : 0,
            a.relayConnectionName || '',
            defaultOwner,
          );
        }
        db.prepare('INSERT INTO migrations (key) VALUES (?)').run('agents_json_import');
      });
      tx();
      console.log(`[ConfigStore] Migrated ${agents.length} agents from agents.json (owner=${defaultOwner})`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') console.error('[ConfigStore] agents.json migration error:', err);
      // Mark as done even if file doesn't exist
      db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('agents_json_import');
    }
  }

  // Migrate nodes.json
  const nodesMigrated = db.prepare('SELECT 1 FROM migrations WHERE key = ?').get('nodes_json_import');
  if (!nodesMigrated) {
    try {
      const raw = fs.readFileSync(NODES_JSON_PATH, 'utf-8');
      const data = JSON.parse(raw);
      const nodes = (data.nodes || []) as any[];
      const defaultOwner = getDefaultOwner();

      const insert = db.prepare(`
        INSERT OR IGNORE INTO nodes (name, label, owner) VALUES (?, ?, ?)
      `);

      const tx = db.transaction(() => {
        for (const n of nodes) {
          insert.run(n.name, n.label || n.name, defaultOwner);
        }
        db.prepare('INSERT INTO migrations (key) VALUES (?)').run('nodes_json_import');
      });
      tx();
      console.log(`[ConfigStore] Migrated ${nodes.length} nodes from nodes.json (owner=${defaultOwner})`);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') console.error('[ConfigStore] nodes.json migration error:', err);
      db.prepare('INSERT OR IGNORE INTO migrations (key) VALUES (?)').run('nodes_json_import');
    }
  }
}

function getDefaultOwner(): string {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  return adminEmails[0] || 'system';
}

// ─── Agent CRUD ───

function rowToAgent(row: any): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    args: JSON.parse(row.args || '[]'),
    cwd: row.cwd,
    yolo: !!row.yolo,
    noTools: !!row.no_tools,
    relay: !!row.relay,
    relayConnectionName: row.relay_connection_name,
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllAgents(): AgentRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all();
  return rows.map(rowToAgent);
}

export function getAgentById(agentId: string): AgentRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as any;
  return row ? rowToAgent(row) : null;
}

export function createAgent(agent: {
  id: string;
  name: string;
  command?: string;
  args?: string[];
  cwd?: string;
  yolo?: boolean;
  noTools?: boolean;
  relay?: boolean;
  relayConnectionName?: string;
  owner: string;
}): AgentRecord {
  const db = getDb();
  db.prepare(`
    INSERT INTO agents (id, name, command, args, cwd, yolo, no_tools, relay, relay_connection_name, owner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id,
    agent.name || agent.id,
    agent.command || 'copilot.exe',
    JSON.stringify(agent.args || []),
    agent.cwd || '',
    agent.yolo !== false ? 1 : 0,
    agent.noTools ? 1 : 0,
    agent.relay ? 1 : 0,
    agent.relayConnectionName || '',
    agent.owner,
  );
  return getAgentById(agent.id)!;
}

export function updateAgent(agentId: string, updates: Partial<{
  name: string;
  command: string;
  args: string[];
  cwd: string;
  yolo: boolean;
  noTools: boolean;
  relay: boolean;
  relayConnectionName: string;
}>): AgentRecord | null {
  const db = getDb();
  const existing = getAgentById(agentId);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
  if (updates.command !== undefined) { fields.push('command = ?'); values.push(updates.command); }
  if (updates.args !== undefined) { fields.push('args = ?'); values.push(JSON.stringify(updates.args)); }
  if (updates.cwd !== undefined) { fields.push('cwd = ?'); values.push(updates.cwd); }
  if (updates.yolo !== undefined) { fields.push('yolo = ?'); values.push(updates.yolo ? 1 : 0); }
  if (updates.noTools !== undefined) { fields.push('no_tools = ?'); values.push(updates.noTools ? 1 : 0); }
  if (updates.relay !== undefined) { fields.push('relay = ?'); values.push(updates.relay ? 1 : 0); }
  if (updates.relayConnectionName !== undefined) { fields.push('relay_connection_name = ?'); values.push(updates.relayConnectionName); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = datetime('now')");
  values.push(agentId);

  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getAgentById(agentId);
}

export function deleteAgent(agentId: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM agents WHERE id = ?').run(agentId);
  return result.changes > 0;
}

// ─── Node CRUD ───

function rowToNode(row: any): NodeRecord {
  return {
    name: row.name,
    label: row.label,
    owner: row.owner,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllNodes(): NodeRecord[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM nodes ORDER BY created_at ASC').all();
  return rows.map(rowToNode);
}

export function getNodeByName(name: string): NodeRecord | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM nodes WHERE name = ?').get(name) as any;
  return row ? rowToNode(row) : null;
}

export function createNode(node: { name: string; label?: string; owner: string }): NodeRecord {
  const db = getDb();
  db.prepare('INSERT INTO nodes (name, label, owner) VALUES (?, ?, ?)').run(
    node.name,
    node.label || node.name,
    node.owner,
  );
  return getNodeByName(node.name)!;
}

export function updateNode(name: string, updates: { label?: string }): NodeRecord | null {
  const db = getDb();
  const existing = getNodeByName(name);
  if (!existing) return null;

  if (updates.label !== undefined) {
    db.prepare("UPDATE nodes SET label = ?, updated_at = datetime('now') WHERE name = ?").run(updates.label, name);
  }
  return getNodeByName(name);
}

export function deleteNode(name: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM nodes WHERE name = ?').run(name);
  return result.changes > 0;
}
