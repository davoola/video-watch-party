const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

function loadUsers() {
  try {
    const rows = getDb().prepare('SELECT username, hash, avatar FROM users').all();
    const normalized = {};
    for (const row of rows) {
      normalized[row.username] = {
        hash: row.hash || '',
        avatar: row.avatar || null,
      };
    }
    return normalized;
  } catch (err) {
    console.error('读取用户数据失败:', err.message);
    return {};
  }
}

// 校验用户名密码，成功时把该用户的数据（含 avatar）一并返回，
// 这样登录流程只需要查询一次，不用校验完密码后再单独查一次。
// 返回 { ok: true, userData } 或 { ok: false, userData: null }。
async function verifyCredentials(username, password) {
  let userObj = null;
  try {
    const row = getDb()
      .prepare('SELECT username, hash, avatar FROM users WHERE username = ?')
      .get(username);
    if (row) {
      userObj = { hash: row.hash || '', avatar: row.avatar || null };
    }
  } catch (err) {
    console.error('查询用户失败:', err.message);
  }

  const hash = userObj ? userObj.hash : null;
  const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8b7XJP9wcOMo.M3KKDp6IsQHN0sQzS';
  const isMatch = await bcrypt.compare(password, hash || DUMMY_HASH);
  const ok = Boolean(hash) && isMatch;

  return { ok, userData: ok ? userObj : null };
}

async function getUserData(username) {
  try {
    const row = getDb()
      .prepare('SELECT username, hash, avatar FROM users WHERE username = ?')
      .get(username);
    if (!row) return null;
    return { hash: row.hash || '', avatar: row.avatar || null };
  } catch (err) {
    console.error('查询用户失败:', err.message);
    return null;
  }
}

async function userExists(username) {
  try {
    const row = getDb().prepare('SELECT 1 AS ok FROM users WHERE username = ?').get(username);
    return Boolean(row);
  } catch (err) {
    console.error('查询用户失败:', err.message);
    return false;
  }
}

function upsertUser(username, hash, avatar) {
  getDb()
    .prepare(
      `INSERT INTO users (username, hash, avatar) VALUES (?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         hash = excluded.hash,
         avatar = COALESCE(excluded.avatar, users.avatar)`
    )
    .run(username, hash, avatar);
}

function listUsernames() {
  try {
    return getDb().prepare('SELECT username FROM users ORDER BY username').all().map((r) => r.username);
  } catch {
    return [];
  }
}

module.exports = {
  loadUsers,
  verifyCredentials,
  getUserData,
  userExists,
  upsertUser,
  listUsernames,
};
