const fs = require('fs');
const bcrypt = require('bcryptjs');
const { USERS_FILE } = require('./config');

// 内部格式统一为 { hash, avatar }，同时兼容旧的纯哈希字符串格式
async function loadUsers() {
  try {
    const raw = await fs.promises.readFile(USERS_FILE, 'utf-8');
    const data = JSON.parse(raw);
    const normalized = {};
    for (const [username, value] of Object.entries(data)) {
      if (typeof value === 'string') {
        normalized[username] = { hash: value, avatar: null };
      } else if (value && typeof value === 'object') {
        normalized[username] = { hash: value.hash || '', avatar: value.avatar || null };
      }
    }
    return normalized;
  } catch (err) {
    console.error('读取用户文件失败:', err.message);
    return {};
  }
}

async function verifyCredentials(username, password) {
  const users = await loadUsers();
  const userObj = users[username];
  const hash = userObj ? userObj.hash : null;

  const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8b7XJP9wcOMo.M3KKDp6IsQHN0sQzS';
  const isMatch = await bcrypt.compare(password, hash || DUMMY_HASH);
  return Boolean(hash) && isMatch;
}

async function getUserData(username) {
  const users = await loadUsers();
  return users[username] || null;
}

async function userExists(username) {
  const users = await loadUsers();
  return Boolean(users[username]);
}

module.exports = { loadUsers, verifyCredentials, getUserData, userExists };