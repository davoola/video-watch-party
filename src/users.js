const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

const SALT_ROUNDS = 12;
const DEFAULT_AVATAR = '/avatar/default.png';
const ROLES = new Set(['admin', 'user']);

function normalizeUser(row) {
  if (!row) return null;
  return {
    username: row.username,
    hash: row.hash || '',
    avatar: row.avatar || DEFAULT_AVATAR,
    displayName: row.display_name || row.username,
    role: row.role === 'admin' ? 'admin' : 'user',
  };
}

function publicUser(row) {
  const u = normalizeUser(row);
  if (!u) return null;
  return {
    username: u.username,
    displayName: u.displayName,
    avatar: u.avatar,
    role: u.role,
  };
}

function listUsers() {
  try {
    return getDb()
      .prepare(
        `SELECT username, hash, avatar, display_name, role FROM users ORDER BY rowid ASC`
      )
      .all()
      .map(publicUser);
  } catch (err) {
    console.error('列出用户失败:', err.message);
    return [];
  }
}

function getUserRow(username) {
  try {
    return getDb()
      .prepare(
        `SELECT username, hash, avatar, display_name, role FROM users WHERE username = ?`
      )
      .get(username);
  } catch (err) {
    console.error('查询用户失败:', err.message);
    return null;
  }
}

function getUserData(username) {
  return normalizeUser(getUserRow(username));
}

function userExists(username) {
  return Boolean(getUserRow(username));
}

function countAdmins() {
  try {
    return getDb().prepare(`SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`).get().c;
  } catch {
    return 0;
  }
}

async function verifyCredentials(username, password) {
  const row = getUserRow(username);
  const userObj = normalizeUser(row);
  const hash = userObj ? userObj.hash : null;
  const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8b7XJP9wcOMo.M3KKDp6IsQHN0sQzS';
  const isMatch = await bcrypt.compare(password, hash || DUMMY_HASH);
  const ok = Boolean(hash) && isMatch;
  return { ok, userData: ok ? userObj : null };
}

function validateUsername(username) {
  if (typeof username !== 'string') return '用户名无效';
  const name = username.trim();
  if (!name) return '用户名不能为空';
  if (name.length > 32) return '用户名最多 32 个字符';
  if (!/^[a-zA-Z0-9_\u4e00-\u9fff-]+$/.test(name)) {
    return '用户名只能包含字母、数字、下划线、连字符或中文';
  }
  return null;
}

function validateDisplayName(displayName) {
  if (typeof displayName !== 'string') return '显示名无效';
  const name = displayName.trim();
  if (!name) return '显示名不能为空';
  if (name.length > 32) return '显示名最多 32 个字符';
  return null;
}

function validatePassword(password, required = true) {
  if (!password) {
    return required ? '密码不能为空' : null;
  }
  if (typeof password !== 'string') return '密码无效';
  if (password.length < 8) return '密码至少需要 8 位';
  if (password.length > 200) return '密码过长';
  return null;
}

function validateRole(role) {
  if (!ROLES.has(role)) return '角色必须是 admin 或 user';
  return null;
}

function validateAvatarPath(avatar) {
  if (avatar == null || avatar === '') return null;
  if (typeof avatar !== 'string') return '头像路径无效';
  if (avatar.length > 200) return '头像路径过长';
  // 只允许站内相对路径，避免 javascript: 等
  if (!avatar.startsWith('/avatar/') && !avatar.startsWith('/user-avatar/')) {
    return '头像路径必须是 /avatar/ 或 /user-avatar/ 下的路径';
  }
  if (avatar.includes('..') || avatar.includes('\\')) return '头像路径非法';
  return null;
}

async function createUser({ username, password, displayName, role, avatar }) {
  const uErr = validateUsername(username);
  if (uErr) throw new Error(uErr);
  const name = username.trim();
  if (userExists(name)) throw new Error('用户名已存在');

  const dErr = validateDisplayName(displayName != null ? displayName : name);
  if (dErr) throw new Error(dErr);
  const pErr = validatePassword(password, true);
  if (pErr) throw new Error(pErr);

  const finalRole = role || (listUsers().length === 0 ? 'admin' : 'user');
  const rErr = validateRole(finalRole);
  if (rErr) throw new Error(rErr);

  const aErr = validateAvatarPath(avatar);
  if (aErr) throw new Error(aErr);

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const dn = (displayName != null ? displayName : name).trim();
  const av = avatar || DEFAULT_AVATAR;

  getDb()
    .prepare(
      `INSERT INTO users (username, hash, avatar, display_name, role) VALUES (?, ?, ?, ?, ?)`
    )
    .run(name, hash, av, dn, finalRole);

  return publicUser(getUserRow(name));
}

async function updateUser(username, patch, { allowRoleChange = false } = {}) {
  const row = getUserRow(username);
  if (!row) throw new Error('用户不存在');

  let displayName = row.display_name;
  let avatar = row.avatar;
  let role = row.role;
  let hash = row.hash;

  if (patch.displayName !== undefined) {
    const dErr = validateDisplayName(patch.displayName);
    if (dErr) throw new Error(dErr);
    displayName = patch.displayName.trim();
  }

  if (patch.avatar !== undefined) {
    const aErr = validateAvatarPath(patch.avatar);
    if (aErr) throw new Error(aErr);
    avatar = patch.avatar || DEFAULT_AVATAR;
  }

  if (patch.role !== undefined) {
    if (!allowRoleChange) throw new Error('无权修改角色');
    const rErr = validateRole(patch.role);
    if (rErr) throw new Error(rErr);
    if (row.role === 'admin' && patch.role !== 'admin' && countAdmins() <= 1) {
      throw new Error('不能取消唯一管理员的管理员身份');
    }
    role = patch.role;
  }

  if (patch.password !== undefined && patch.password !== '') {
    const pErr = validatePassword(patch.password, true);
    if (pErr) throw new Error(pErr);
    hash = await bcrypt.hash(patch.password, SALT_ROUNDS);
  }

  getDb()
    .prepare(
      `UPDATE users SET hash = ?, avatar = ?, display_name = ?, role = ? WHERE username = ?`
    )
    .run(hash, avatar, displayName, role, username);

  return publicUser(getUserRow(username));
}

function deleteUser(username, actorUsername) {
  const row = getUserRow(username);
  if (!row) throw new Error('用户不存在');
  if (username === actorUsername) throw new Error('不能删除当前登录的账号');
  if (row.role === 'admin' && countAdmins() <= 1) {
    throw new Error('不能删除唯一的管理员');
  }
  getDb().prepare(`DELETE FROM users WHERE username = ?`).run(username);
  return true;
}

module.exports = {
  DEFAULT_AVATAR,
  listUsers,
  getUserData,
  getUserRow,
  userExists,
  verifyCredentials,
  createUser,
  updateUser,
  deleteUser,
  countAdmins,
  publicUser,
  validateUsername,
  validateDisplayName,
  validatePassword,
  validateAvatarPath,
};
