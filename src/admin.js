const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const crypto = require('crypto');
const { requireAuth, requireAdmin, fillSessionUser } = require('./auth');
const {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  getUserData,
  DEFAULT_AVATAR,
} = require('./users');
const { getSiteName, setSiteName } = require('./siteSettings');
const { listAuditLogs, purgeAuditLogs, writeAuditLog, getClientIp } = require('./auditLog');
const { DATABASE_PATH, BACKUP_DIR } = require('./config');
const { getDb } = require('./db');

const router = express.Router();

const AVATAR_DIR = path.join(__dirname, '..', 'data', 'user-avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const ALLOWED_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter(req, file, cb) {
    if (ALLOWED_MIME[file.mimetype]) cb(null, true);
    else cb(new Error('仅支持 PNG / JPEG / WebP / GIF 图片'));
  },
});

// ---- 管理员：用户列表 ----
router.get('/api/admin/users', requireAdmin, (req, res) => {
  res.json({ users: listUsers() });
});

// ---- 管理员：创建用户 ----
router.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, displayName, role, avatar } = req.body || {};
    const user = await createUser({
      username,
      password,
      displayName,
      role: role || 'user',
      avatar: avatar || DEFAULT_AVATAR,
    });
    res.json({ ok: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message || '创建失败' });
  }
});

// ---- 管理员：更新用户 ----
router.put('/api/admin/users/:username', requireAdmin, async (req, res) => {
  try {
    const target = req.params.username;
    const body = req.body || {};
    const patch = {};
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.avatar !== undefined) patch.avatar = body.avatar;
    if (body.role !== undefined) patch.role = body.role;
    if (body.password !== undefined && body.password !== '') patch.password = body.password;

    const updated = await updateUser(target, patch, { allowRoleChange: true });

    // 若改的是当前登录管理员自己，刷新 session
    if (req.session.user === target) {
      fillSessionUser(req.session, {
        username: updated.username,
        displayName: updated.displayName,
        avatar: updated.avatar,
        role: updated.role,
      });
    }

    res.json({ ok: true, user: updated });
  } catch (err) {
    res.status(400).json({ error: err.message || '更新失败' });
  }
});

// ---- 管理员：删除用户 ----
router.delete('/api/admin/users/:username', requireAdmin, (req, res) => {
  try {
    deleteUser(req.params.username, req.session.user);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message || '删除失败' });
  }
});

// ---- 站点名称 ----
router.get('/api/admin/site-name', requireAdmin, (req, res) => {
  res.json({ siteName: getSiteName() });
});

router.put('/api/admin/site-name', requireAdmin, (req, res) => {
  try {
    const { siteName } = req.body || {};
    const name = setSiteName(siteName);
    res.json({ ok: true, siteName: name });
  } catch (err) {
    res.status(400).json({ error: err.message || '更新失败' });
  }
});

// ---- 头像上传（登录用户可传自己的；管理员可为任意用户上传后手动设路径）----
router.post('/api/avatar-upload', requireAuth, (req, res) => {
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    if (!req.file) {
      return res.status(400).json({ error: '请选择图片文件' });
    }
    // 简单魔数校验
    const buf = req.file.buffer;
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    const isGif = buf[0] === 0x47 && buf[1] === 0x49;
    const isWebp =
      buf.length > 12 &&
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45;
    if (!isPng && !isJpg && !isGif && !isWebp) {
      return res.status(400).json({ error: '文件内容不是有效图片' });
    }

    const ext =
      ALLOWED_MIME[req.file.mimetype] ||
      (isPng ? '.png' : isJpg ? '.jpg' : isGif ? '.gif' : '.webp');
    const safeUser = String(req.session.user).replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '_');
    const filename = `${safeUser}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(AVATAR_DIR, filename), buf);
    const url = `/user-avatar/${filename}`;
    res.json({ ok: true, avatar: url });
  });
});

// 访问用户上传的头像（需登录）
router.get('/user-avatar/:filename', requireAuth, (req, res) => {
  const filename = req.params.filename;
  if (!/^[a-zA-Z0-9_\u4e00-\u9fff.-]+$/.test(filename) || filename.includes('..')) {
    return res.status(400).json({ error: '非法文件名' });
  }
  const filePath = path.join(AVATAR_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: '文件不存在' });
  }
  res.sendFile(filePath);
});


// ---- 审计日志 ----
router.get('/api/admin/audit-logs', requireAdmin, (req, res) => {
  try {
    const limit = req.query.limit;
    const offset = req.query.offset;
    const data = listAuditLogs({ limit, offset });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message || '读取失败' });
  }
});

// body: { days?: number }  days>0 删除 N 天前；不传或 days=0 清空全部
router.post('/api/admin/audit-logs/purge', requireAdmin, (req, res) => {
  try {
    const days = parseInt((req.body || {}).days, 10);
    let beforeTs = null;
    let summary = '清空全部审计日志';
    if (Number.isFinite(days) && days > 0) {
      beforeTs = Date.now() - days * 24 * 60 * 60 * 1000;
      summary = `清理 ${days} 天前的审计日志`;
    }
    const deleted = purgeAuditLogs(beforeTs);
    writeAuditLog({
      actor: req.session.user,
      action: 'purge_logs',
      objectType: 'audit',
      summary: `${summary}（删除 ${deleted} 条）`,
      ip: getClientIp(req),
    });
    res.json({ ok: true, deleted });
  } catch (err) {
    res.status(400).json({ error: err.message || '清理失败' });
  }
});

// WAL 合并进主库
router.post('/api/admin/db/checkpoint', requireAdmin, (req, res) => {
  try {
    const result = getDb().pragma('wal_checkpoint(TRUNCATE)');
    writeAuditLog({
      actor: req.session.user,
      action: 'db_checkpoint',
      objectType: 'database',
      summary: '写入主文件（WAL checkpoint TRUNCATE）',
      ip: getClientIp(req),
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'checkpoint 失败' });
  }
});

// 先 checkpoint，再备份到 BACKUP_DIR/原库名-YYYYMMDD.db
router.post('/api/admin/db/backup', requireAdmin, (req, res) => {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    getDb().pragma('wal_checkpoint(TRUNCATE)');

    const base = path.basename(DATABASE_PATH, path.extname(DATABASE_PATH)) || 'private-cinema';
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const destName = `${base}-${y}${m}${d}.db`;
    const destPath = path.join(BACKUP_DIR, destName);

    fs.copyFileSync(DATABASE_PATH, destPath);

    writeAuditLog({
      actor: req.session.user,
      action: 'db_backup',
      objectType: 'database',
      summary: `备份数据库到 ${destPath}`,
      ip: getClientIp(req),
    });
    res.json({ ok: true, path: destPath, file: destName });
  } catch (err) {
    console.error('备份数据库失败:', err);
    res.status(500).json({ error: err.message || '备份失败' });
  }
});

module.exports = { router, AVATAR_DIR };
