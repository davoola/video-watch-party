const express = require('express');
const { verifyCredentials } = require('./users');

const router = express.Router();

// ---- 简单的登录失败限流（内存版，单实例够用） ----
// key: ip+username，value: { count, firstAttemptAt }
const failedAttempts = new Map();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 10 * 60 * 1000; // 10 分钟窗口
const LOCK_MS = 15 * 60 * 1000; // 超过次数后锁定 15 分钟

function getKey(req, username) {
  return `${req.ip}:${username}`;
}

function isLocked(req, username) {
  const key = getKey(req, username);
  const entry = failedAttempts.get(key);
  if (!entry) return false;

  const now = Date.now();
  // 窗口过期，重置
  if (now - entry.firstAttemptAt > WINDOW_MS && !entry.lockedUntil) {
    failedAttempts.delete(key);
    return false;
  }
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return true;
  }
  if (entry.lockedUntil && now >= entry.lockedUntil) {
    failedAttempts.delete(key);
    return false;
  }
  return false;
}

function recordFailure(req, username) {
  const key = getKey(req, username);
  const now = Date.now();
  const entry = failedAttempts.get(key) || { count: 0, firstAttemptAt: now };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCK_MS;
  }
  failedAttempts.set(key, entry);
}

function clearFailures(req, username) {
  failedAttempts.delete(getKey(req, username));
}

// 定期清理过期记录，避免内存无限增长
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failedAttempts.entries()) {
    const expired =
      (!entry.lockedUntil && now - entry.firstAttemptAt > WINDOW_MS) ||
      (entry.lockedUntil && now > entry.lockedUntil);
    if (expired) failedAttempts.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ---- 中间件：要求已登录 ----
function requireAuth(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.status(401).json({ error: '未登录或登录已过期' });
}

// 用于页面路由（未登录则跳转到登录页，而不是返回 JSON）
function requireAuthPage(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  return res.redirect('/login.html');
}

// ---- 路由 ----
router.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }

  // 超长 username 会被拼进限流用的 Map key（ip:username），理论上可以让这个 Map
  // 无限增长；超长 password 交给 bcrypt.compare() 也是没必要的开销（bcrypt 本身
  // 只认前 72 字节，多余部分纯属浪费）。合法用户名/密码不可能长到这个地步，
  // 这里在真正开始鉴权逻辑之前就拦掉，成本最低。
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

    // 防止 Session Fixation：登录成功后重新生成 session id
    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regenerate error:', err);
        return res.status(500).json({ error: '服务器错误，请稍后重试' });
      }
      req.session.user = username;
      req.session.avatar = userData?.avatar || null;
      res.json({ ok: true, username });
    });
  } catch (err) {
    console.error('登录处理出错:', err);
    res.status(500).json({ error: '服务器错误，请稍后重试' });
  }
});

router.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.session.user, avatar: req.session.avatar || null });
});

module.exports = { router, requireAuth, requireAuthPage };
