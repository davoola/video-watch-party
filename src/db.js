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
      avatar TEXT
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
      ts INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_messages_room_ts
      ON chat_messages(room_id, ts);
  `);

  migrateUsersFromJsonIfNeeded();

  return db;
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
    'INSERT OR IGNORE INTO users (username, hash, avatar) VALUES (?, ?, ?)'
  );
  const tx = db.transaction((entries) => {
    for (const [username, value] of entries) {
      if (typeof value === 'string') {
        insert.run(username, value, null);
      } else if (value && typeof value === 'object' && value.hash) {
        insert.run(username, value.hash, value.avatar || null);
      }
    }
  });
  tx(Object.entries(raw));
  const after = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (after > 0) {
    console.log(`已从 users.json 迁移 ${after} 个用户到 SQLite 数据库`);
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
