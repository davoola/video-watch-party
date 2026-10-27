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

module.exports = { router, AVATAR_DIR };
