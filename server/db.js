import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Central database file. Override with the DB_PATH environment variable.
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'app.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');

// Every conversation carries its own tool policy; new chats start here.
export const DEFAULT_WORKDIR = os.homedir();

// Parent folder for the auto-created per-chat working folders. New chats get
// {aitemp_root}/{chat id}. The root itself is a user-editable setting so it can
// live on another drive; it defaults to {home}/aitemp.
export const DEFAULT_AITEMP_ROOT = path.join(os.homedir(), 'aitemp');
export function aitempRoot() {
  const raw = String(getSetting('aitemp_root') || '').trim();
  return path.resolve(raw || DEFAULT_AITEMP_ROOT);
}
export const POLICY_DEFAULTS = {
  workdir: DEFAULT_WORKDIR,
  approval_mode: 'ask',
  file_access: 'restricted',
  shell_access: 'restricted',
  files_enabled: 1,
  shell_enabled: 1,
  mcp_disabled: null
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS system_prompts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  content     TEXT NOT NULL,
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL DEFAULT 'New chat',
  prompt_id     INTEGER REFERENCES system_prompts(id) ON DELETE SET NULL,
  model         TEXT,
  image_url     TEXT,
  workdir       TEXT,
  approval_mode TEXT NOT NULL DEFAULT 'ask',
  file_access   TEXT NOT NULL DEFAULT 'restricted',
  shell_access  TEXT NOT NULL DEFAULT 'restricted',
  files_enabled INTEGER NOT NULL DEFAULT 1,
  shell_enabled INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL DEFAULT '',
  image_url       TEXT,
  tool_calls      TEXT,
  tool_call_id    TEXT,
  tokens          INTEGER,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

-- Every text file a turn's tools changed, keyed to the user message that
-- started the turn. The before/after text is kept so the UI can show a diff and
-- offer a per-file revert. Rows are capped in size by the tracker.
CREATE TABLE IF NOT EXISTS file_changes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,
  rel_path        TEXT,
  before_exists   INTEGER NOT NULL DEFAULT 0,
  before_text     TEXT,
  after_exists    INTEGER NOT NULL DEFAULT 0,
  after_text      TEXT,
  reverted_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(message_id, path)
);

CREATE INDEX IF NOT EXISTS idx_file_changes_message ON file_changes(message_id);
CREATE INDEX IF NOT EXISTS idx_file_changes_conversation ON file_changes(conversation_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  transport   TEXT NOT NULL DEFAULT 'stdio',
  command     TEXT,
  args        TEXT DEFAULT '[]',
  url         TEXT,
  headers     TEXT DEFAULT '{}',
  env         TEXT DEFAULT '{}',
  enabled     INTEGER NOT NULL DEFAULT 1,
  builtin_key TEXT,
  approval    TEXT NOT NULL DEFAULT 'auto',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initDb() {
  db.exec(SCHEMA);

  // Lightweight column migrations for databases created by earlier versions.
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!msgCols.includes('tool_call_id')) db.exec('ALTER TABLE messages ADD COLUMN tool_call_id TEXT');

  // Per-reply extras: chain of thought, timing, token speeds and produced files.
  const addMsgCol = (ddl) => {
    if (!msgCols.includes(ddl.split(' ')[0])) db.exec(`ALTER TABLE messages ADD COLUMN ${ddl}`);
  };
  addMsgCol('reasoning TEXT');
  addMsgCol('duration_ms INTEGER');
  addMsgCol('prompt_tokens INTEGER');
  addMsgCol('completion_tokens INTEGER');
  addMsgCol('pp_tok_s REAL');
  addMsgCol('tg_tok_s REAL');
  addMsgCol('files TEXT');
  // Per API round token detail: [{r,prompt,completion,prompt_ms,predicted_ms}, …]
  // so the UI can show tokens processed/generated for each part of a reply.
  addMsgCol('token_detail TEXT');
  // Ordered layout of a reply: [{t:'r'|'t'|'tc'|'f',...}, ...] so thinking, answer
  // text and tool calls reload in the exact order they streamed in.
  addMsgCol('segments TEXT');
  // Tool-result extras: how long the call took, and whether the user cancelled it.
  addMsgCol('tool_duration_ms INTEGER');
  addMsgCol('tool_cancelled INTEGER');
  // Why a reply stopped early (upstream/model failure), kept on the message row
  // so the reason survives a reload instead of living in a transient toast.
  addMsgCol('error TEXT');

  // file_changes is created by SCHEMA above; keep it forward-compatible with
  // databases created before the revert marker existed.
  const changeCols = db.prepare('PRAGMA table_info(file_changes)').all().map((c) => c.name);
  if (changeCols.length && !changeCols.includes('reverted_at')) {
    db.exec('ALTER TABLE file_changes ADD COLUMN reverted_at TEXT');
  }

  const mcpCols = db.prepare('PRAGMA table_info(mcp_servers)').all().map((c) => c.name);
  if (!mcpCols.includes('builtin_key')) db.exec('ALTER TABLE mcp_servers ADD COLUMN builtin_key TEXT');
  if (!mcpCols.includes('approval')) db.exec("ALTER TABLE mcp_servers ADD COLUMN approval TEXT NOT NULL DEFAULT 'auto'");

  // Per-conversation tool policy (each chat has its own working folder and switches).
  const convCols = db.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name);
  const addConvCol = (ddl) => {
    if (!convCols.includes(ddl.split(' ')[0])) db.exec(`ALTER TABLE conversations ADD COLUMN ${ddl}`);
  };
  addConvCol('workdir TEXT');
  addConvCol("approval_mode TEXT NOT NULL DEFAULT 'ask'");
  addConvCol("file_access TEXT NOT NULL DEFAULT 'restricted'");
  addConvCol("shell_access TEXT NOT NULL DEFAULT 'restricted'");
  addConvCol('files_enabled INTEGER NOT NULL DEFAULT 1');
  addConvCol('shell_enabled INTEGER NOT NULL DEFAULT 1');
  // JSON array of custom MCP server names this chat has switched off.
  addConvCol('mcp_disabled TEXT');
  addConvCol("reasoning_effort TEXT NOT NULL DEFAULT 'auto'");
  // Rolling context summary (auto-compress): text + id of last summarized msg.
  addConvCol('summary TEXT');
  addConvCol('summarized_upto INTEGER NOT NULL DEFAULT 0');
  // Owner of the conversation. NULL means it predates multi-user auth and is
  // claimed by the first user to register (see routes/auth.js).
  addConvCol('user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
  db.prepare("UPDATE conversations SET workdir = ? WHERE workdir IS NULL OR workdir = ''").run(DEFAULT_WORKDIR);

  // Seed default settings (first run only).
  const setDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  setDefault.run('api_base_url', process.env.OPENAI_BASE_URL || 'http://localhost:1234/v1');
  setDefault.run('api_key', process.env.OPENAI_API_KEY || '');
  setDefault.run('model', process.env.OPENAI_MODEL || '');
  setDefault.run('temperature', '0.7');
  setDefault.run('max_tokens', '');
  // Empty means unlimited: the tool loop runs until the model answers.
  setDefault.run('max_tool_rounds', '');
  // The approval / access switches live on each conversation, so the only
  // global built-in setting left is the shell command timeout.
  setDefault.run('builtin_shell_timeout', '120');
  // Parent folder for auto-created per-chat working folders ({home}/aitemp/{id}).
  setDefault.run('aitemp_root', DEFAULT_AITEMP_ROOT);
  // Thinking/reasoning effort for reasoning-capable models (auto = don't send it).
  setDefault.run('reasoning_effort', 'auto');
  // Token window used for the context meter. 0/blank = unknown (meter hidden
  // until the server reports real usage).
  setDefault.run('context_window', '');
  // Sliding-window context: only the most recent `context_keep` tokens are sent
  // verbatim each turn; older turns roll into a summary. 0/blank disables
  // trimming (sends full history). `context_compress_at` is an optional earlier
  // hard cap, only used if set smaller than the window.
  setDefault.run('context_compress_at', '');
  setDefault.run('context_keep', '8000');
  // New accounts are opt-in once the first admin exists. The first user is
  // always allowed to sign up (setup); afterwards an admin enables this in
  // Settings before anyone else can register.
  setDefault.run('allow_registration', '0');

  // Remembered tool approvals used to be a flat list of tool names shared by
  // every account. Grants are now scoped per user (`${userId}::${tool}`), so
  // migrate the legacy list to the first user (or drop it when there is none).
  const legacyGrants = db.prepare("SELECT value FROM settings WHERE key = 'builtin_always_allowed'").get();
  if (legacyGrants) {
    try {
      const arr = JSON.parse(legacyGrants.value || '[]');
      if (Array.isArray(arr) && arr.some((g) => typeof g === 'string' && !g.includes('::'))) {
        const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
        const migrated = first
          ? arr.filter((g) => typeof g === 'string').map((g) => (g.includes('::') ? g : `${first.id}::${g}`))
          : [];
        db.prepare("UPDATE settings SET value = ? WHERE key = 'builtin_always_allowed'").run(JSON.stringify(migrated));
      }
    } catch {
      db.prepare("UPDATE settings SET value = '[]' WHERE key = 'builtin_always_allowed'").run();
    }
  }

  // Seed default system prompts (first run only).
  const count = db.prepare('SELECT COUNT(*) AS c FROM system_prompts').get().c;
  if (count === 0) {
    const ins = db.prepare(
      'INSERT INTO system_prompts (name, description, content, is_default) VALUES (?, ?, ?, ?)'
    );
    ins.run(
      'General Assistant',
      'Helpful, concise general-purpose assistant',
      'You are a helpful, friendly assistant. Answer clearly and concisely. Use markdown formatting when it helps readability. If you are unsure about something, say so.',
      1
    );
    ins.run(
      'Coding Expert',
      'Senior software engineer answering code questions',
      'You are a senior software engineer. Provide accurate, production-quality code and explanations. Prefer minimal, surgical examples. Always mention edge cases and possible pitfalls.',
      0
    );
    ins.run(
      'Creative Writer',
      'Imaginative storyteller with vivid prose',
      'You are a creative writer. Craft vivid, original prose. Show, do not tell. Avoid clichés and keep the pacing tight.',
      0
    );
  }
}

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value == null ? '' : String(value));
}

export function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

/**
 * Make sure the built-in MCP servers have a row each, so they show up in the
 * MCP settings list and can be switched off. Existing rows keep their state
 * (a disabled built-in server stays disabled).
 */
export function ensureBuiltinServers(entries) {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO mcp_servers (name, transport, builtin_key, enabled) VALUES (?, ?, ?, 1)'
  );
  for (const e of entries) ins.run(e.name, 'builtin', e.key);
}
