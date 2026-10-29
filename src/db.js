const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATABASE_PATH, USERS_FILE } = require('./config');

let db = null;

function getDb() {
  if (db) return db;

  const dir = path.dirname(DATABASE_PATH);
  fs.mkdirSync(dir, { recursive: true });

  db = new Database(DATABASE_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY NOT NULL,
      hash TEXT NOT NULL,
      avatar TEXT,
      display_name TEXT,
      role TEXT NOT NULL DEFAULT 'user'
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT NOT NULL,
      from_user TEXT NOT NULL,
      avatar TEXT,
      type TEXT NOT NULL,
      text TEXT,
      image_url TEXT,
      audio_url TEXT,
      duration_sec INTEGER,
      ts INTEGER NOT NULL,
      display_name TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_room_ts
      ON chat_messages(room_id, ts);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      object_type TEXT,
      summary TEXT,
      ip TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_audit_logs_ts ON audit_logs(ts DESC);
  `);

  migrateUsersSchema();
  migrateUsersFromJsonIfNeeded();
  ensureFirstUserIsAdmin();

  return db;
}

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function migrateUsersSchema() {
  const cols = tableColumns('users');
  if (!cols.includes('display_name')) {
    db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`);
  }
  if (!cols.includes('role')) {
    db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
  }
  // 旧数据：display_name 为空时用 username 填充
  db.prepare(
    `UPDATE users SET display_name = username WHERE display_name IS NULL OR display_name = ''`
  ).run();
  // 角色兜底
  db.prepare(
    `UPDATE users SET role = 'user' WHERE role IS NULL OR role NOT IN ('admin', 'user')`
  ).run();

  const chatCols = tableColumns('chat_messages');
  if (!chatCols.includes('display_name')) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN display_name TEXT`);
  }
}

// 首次启动时，如果数据库里还没有用户，而 config/users.json 里已有账号，
// 就把它们迁进 SQLite，避免升级后已有部署丢账号。迁完后不再依赖 users.json。
function migrateUsersFromJsonIfNeeded() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return;
  }
  if (!raw || typeof raw !== 'object') return;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO users (username, hash, avatar, display_name, role)
     VALUES (?, ?, ?, ?, ?)`
  );
  const entries = Object.entries(raw);
  const tx = db.transaction((list) => {
    list.forEach(([username, value], index) => {
      let hash = '';
      let avatar = null;
      if (typeof value === 'string') {
        hash = value;
      } else if (value && typeof value === 'object') {
        hash = value.hash || '';
        avatar = value.avatar || null;
      }
      if (!hash) return;
      // 迁移顺序中第一个用户设为管理员
      const role = index === 0 ? 'admin' : 'user';
      insert.run(username, hash, avatar, username, role);
    });
  });
  tx(entries);
  const after = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (after > 0) {
    console.log(`已从 users.json 迁移 ${after} 个用户到 SQLite 数据库`);
  }
}

// 确保至少有一个管理员：若库中已有用户但没有任何 admin，把 rowid 最小的那个升为 admin
function ensureFirstUserIsAdmin() {
  const adminCount = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`).get().c;
  if (adminCount > 0) return;
  const first = db.prepare(`SELECT username FROM users ORDER BY rowid ASC LIMIT 1`).get();
  if (first) {
    db.prepare(`UPDATE users SET role = 'admin' WHERE username = ?`).run(first.username);
    console.log(`已将用户「${first.username}」设为管理员（库中原无管理员）`);
  }
}

function closeDb() {
  if (db) {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
    db = null;
  }
}

module.exports = { getDb, closeDb };
