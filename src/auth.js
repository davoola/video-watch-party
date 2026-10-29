const express = require('express');
const {
  verifyCredentials,
  getUserData,
  updateUser,
  validatePassword,
} = require('./users');
const { writeAuditLog, getClientIp } = require('./auditLog');

const router = express.Router();

// ---- 登录失败限流（按 IP + 用户名）----
const failedAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;

function getKey(req, username) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  return `${ip}:${username}`;
}

function isLocked(req, username) {
  const entry = failedAttempts.get(getKey(req, username));
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    failedAttempts.delete(getKey(req, username));
    return false;
  }
  return false;
}

function recordFailure(req, username) {
  const key = getKey(req, username);
  const now = Date.now();
  let entry = failedAttempts.get(key);
  if (!entry || now - entry.firstAttemptAt > WINDOW_MS) {
    entry = { count: 0, firstAttemptAt: now, lockedUntil: null };
  }
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCK_MS;
  }
  failedAttempts.set(key, entry);
}

function clearFailures(req, username) {
  failedAttempts.delete(getKey(req, username));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failedAttempts.entries()) {
    const expired =
      (!entry.lockedUntil && now - entry.firstAttemptAt > WINDOW_MS) ||
      (entry.lockedUntil && now > entry.lockedUntil);
    if (expired) failedAttempts.delete(key);
  }
}, 5 * 60 * 1000).unref();

function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: '未登录或登录已过期' });
}

function requireAuthPage(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.redirect('/login.html');
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: '未登录或登录已过期' });
  }
  if (req.session.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  return next();
}

function requireAdminPage(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login.html');
  }
  if (req.session.role !== 'admin') {
    return res.redirect('/index.html');
  }
  return next();
}

function fillSessionUser(session, userData) {
  session.user = userData.username;
  session.avatar = userData.avatar || null;
  session.displayName = userData.displayName || userData.username;
  session.role = userData.role === 'admin' ? 'admin' : 'user';
}

router.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  if (username.length > 100 || password.length > 200) {
    return res.status(400).json({ error: '输入超出允许长度' });
  }

  if (isLocked(req, username)) {
    return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试' });
  }

  try {
    const { ok, userData } = await verifyCredentials(username, password);
    if (!ok) {
      recordFailure(req, username);
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    clearFailures(req, username);

    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regenerate error:', err);
        return res.status(500).json({ error: '服务器错误，请稍后重试' });
      }
      fillSessionUser(req.session, userData);
      writeAuditLog({
        actor: userData.username,
        action: 'login',
        objectType: 'session',
        summary: `用户登录（显示名：${userData.displayName || userData.username}）`,
        ip: getClientIp(req),
      });
      res.json({
        ok: true,
        username: userData.username,
        displayName: userData.displayName,
        role: userData.role,
        avatar: userData.avatar,
      });
    });
  } catch (err) {
    console.error('登录处理出错:', err);
    res.status(500).json({ error: '服务器错误，请稍后重试' });
  }
});

router.post('/api/logout', (req, res) => {
  const actor = req.session && req.session.user;
  const ip = getClientIp(req);
  req.session.destroy(() => {
    if (actor) {
      writeAuditLog({
        actor,
        action: 'logout',
        objectType: 'session',
        summary: '用户退出登录',
        ip,
      });
    }
    res.json({ ok: true });
  });
});

router.get('/api/me', requireAuth, (req, res) => {
  // 每次从数据库刷新一次，避免管理员改了显示名/头像/角色后 session 过旧
  const fresh = getUserData(req.session.user);
  if (!fresh) {
    return req.session.destroy(() => {
      res.status(401).json({ error: '用户不存在或已被删除' });
    });
  }
  fillSessionUser(req.session, fresh);
  res.json({
    username: fresh.username,
    displayName: fresh.displayName,
    avatar: fresh.avatar,
    role: fresh.role,
  });
});

// 当前用户修改自己的资料：显示名、密码、头像（不能改角色和用户名）
router.put('/api/me', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};

    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.avatar !== undefined) patch.avatar = body.avatar;
    if (body.password !== undefined && body.password !== '') {
      const pErr = validatePassword(body.password, true);
      if (pErr) return res.status(400).json({ error: pErr });
      // 改密码需要验证当前密码
      if (!body.currentPassword) {
        return res.status(400).json({ error: '修改密码需要提供当前密码' });
      }
      const { ok } = await verifyCredentials(req.session.user, body.currentPassword);
      if (!ok) return res.status(401).json({ error: '当前密码不正确' });
      patch.password = body.password;
    }

    const updated = await updateUser(req.session.user, patch, { allowRoleChange: false });
    fillSessionUser(req.session, {
      username: updated.username,
      displayName: updated.displayName,
      avatar: updated.avatar,
      role: updated.role,
    });
    res.json({ ok: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message || '更新失败' });
  }
});

module.exports = {
  router,
  requireAuth,
  requireAuthPage,
  requireAdmin,
  requireAdminPage,
  fillSessionUser,
};
