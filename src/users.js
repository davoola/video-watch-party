const fs = require('fs');
const bcrypt = require('bcryptjs');
const { USERS_FILE } = require('./config');

// 每次都从磁盘重新读取，方便管理员用 createUser 脚本改完用户文件后无需重启服务
function loadUsers() {
  try {
    const raw = fs.readFileSync(USERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('读取用户文件失败:', err.message);
    return {};
  }
}

// 校验用户名密码，返回 true/false。
// 注意：无论用户名是否存在，都会执行一次 bcrypt.compare，
// 防止通过响应时间差判断"用户名是否存在"（时序攻击的一种简单防护）。
async function verifyCredentials(username, password) {
  const users = loadUsers();
  const hash = users[username];

  // 用一个固定的假哈希占位，保证耗时和真实校验基本一致
  const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8b7XJP9wcOMo.M3KKDp6IsQHN0sQzS';
  const targetHash = hash || DUMMY_HASH;

  const isMatch = await bcrypt.compare(password, targetHash);
  return Boolean(hash) && isMatch;
}

function userExists(username) {
  const users = loadUsers();
  return Boolean(users[username]);
}

module.exports = { loadUsers, verifyCredentials, userExists };
