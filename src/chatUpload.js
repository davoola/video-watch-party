const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { CHAT_UPLOAD_DIR, CHAT_IMAGE_RETENTION_DAYS } = require('./config');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

// 只信任"文件内容的魔数（magic bytes）"，不信任客户端声称的扩展名或 Content-Type。
// 这样即使有人把恶意文件伪装成 .jpg 上传，也会在这里被识别并拒绝。
const SIGNATURES = [
  { ext: 'png', mime: 'image/png', check: (buf) => buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', mime: 'image/jpeg', check: (buf) => buf.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) },
  { ext: 'gif', mime: 'image/gif', check: (buf) => buf.slice(0, 4).toString('ascii') === 'GIF8' },
  {
    ext: 'webp',
    mime: 'image/webp',
    check: (buf) => buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP',
  },
];

function detectImageType(buffer) {
  for (const sig of SIGNATURES) {
    if (buffer.length >= 12 && sig.check(buffer)) return sig;
  }
  return null;
}

// 上传时先收到内存里（不直接写到磁盘文件名由用户决定），
// 校验通过后由我们自己生成随机文件名再落盘，从源头杜绝路径穿越和文件覆盖风险。
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
}).single('image');

function handleChatImageUpload(req, res) {
  upload(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `图片不能超过 ${MAX_FILE_SIZE / 1024 / 1024}MB` });
      }
      return res.status(400).json({ error: '上传失败: ' + err.message });
    }

    if (!req.file) {
      return res.status(400).json({ error: '没有收到图片文件' });
    }

    const sig = detectImageType(req.file.buffer);
    if (!sig) {
      return res.status(400).json({ error: '不支持的图片格式（仅支持 PNG/JPG/GIF/WEBP）' });
    }

    const filename = crypto.randomBytes(16).toString('hex') + '.' + sig.ext;
    const fullPath = path.join(CHAT_UPLOAD_DIR, filename);

    fs.writeFile(fullPath, req.file.buffer, (writeErr) => {
      if (writeErr) {
        console.error('保存聊天图片失败:', writeErr);
        return res.status(500).json({ error: '服务器保存图片失败' });
      }
      res.json({ ok: true, url: `/chat-image/${filename}` });
    });
  });
}

// 只允许形如 <32位hex>.<ext> 的文件名，杜绝路径穿越（../、绝对路径等一律拒绝）
const SAFE_FILENAME_RE = /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/;

function isValidChatImageFilename(filename) {
  return typeof filename === 'string' && SAFE_FILENAME_RE.test(filename);
}

const EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function serveChatImage(req, res) {
  const filename = req.params.filename;

  if (!isValidChatImageFilename(filename)) {
    return res.status(400).json({ error: '非法文件名' });
  }

  const fullPath = path.join(CHAT_UPLOAD_DIR, filename);

  // 双重确认：即便文件名通过了正则，也再校验一次最终路径确实落在上传目录内
  const normalizedRoot = path.resolve(CHAT_UPLOAD_DIR) + path.sep;
  if (!path.resolve(fullPath).startsWith(normalizedRoot)) {
    return res.status(403).end();
  }

  fs.access(fullPath, fs.constants.R_OK, (err) => {
    if (err) return res.status(404).json({ error: '图片不存在' });

    const ext = filename.split('.').pop();
    res.setHeader('Content-Type', EXT_MIME[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');

    // fs.access 通过之后到真正开始读取之间，文件仍可能被删除或遇到 I/O 错误；
    // ReadStream 若没有 error 监听器，未捕获的 error 事件会直接让 Node 进程崩溃。
    // 和 videoStream.js / docDownload.js / imageView.js 保持一致，显式监听 error。
    const stream = fs.createReadStream(fullPath);
    stream.on('error', (err) => {
      console.error('聊天图片读取错误:', err.message);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  });
}

// 清理超过保留期限的聊天图片。用异步 API（不是 readdirSync/statSync/unlinkSync），
// 避免在文件数量较多时同步阻塞事件循环。
// CHAT_IMAGE_RETENTION_DAYS 设为 0 表示关闭自动清理（保留所有图片）。
async function cleanupOldChatImages() {
  if (!CHAT_IMAGE_RETENTION_DAYS || CHAT_IMAGE_RETENTION_DAYS <= 0) return;

  const maxAgeMs = CHAT_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let files;
  try {
    files = await fs.promises.readdir(CHAT_UPLOAD_DIR);
  } catch (err) {
    console.error('[聊天图片清理] 读取目录失败:', err.message);
    return;
  }

  let deletedCount = 0;
  for (const file of files) {
    const fullPath = path.join(CHAT_UPLOAD_DIR, file);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile()) continue;
      // 优先用创建时间（birthtime）判断"这张图片是不是该清理了"，而不是修改时间（mtime）——
      // 上传后的聊天图片理论上不会再被修改，但像 rsync 备份恢复、touch 之类的操作会更新 mtime，
      // 导致本该清理的旧文件被误判成"新鲜"而豁免。
      // 但 birthtime 不是所有文件系统都支持：不支持的情况下 Node.js 可能回退成 0（Unix 纪元），
      // 如果直接信它，会让所有文件都显得"无限久远"，反而导致全部被误删——所以这里做了兜底，
      // birthtime 明显不可信（<= 0）时退回用 mtime，保持和之前一样的行为。
      const createdAtMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
      if (now - createdAtMs > maxAgeMs) {
        await fs.promises.unlink(fullPath);
        deletedCount++;
      }
    } catch (err) {
      // 文件可能在检查过程中被并发删除/读取失败，忽略单个文件的错误，不影响其他文件的清理
      console.error(`[聊天图片清理] 处理文件失败 ${file}:`, err.message);
    }
  }

  if (deletedCount > 0) {
    console.log(`[聊天图片清理] 已删除 ${deletedCount} 张超过 ${CHAT_IMAGE_RETENTION_DAYS} 天的聊天图片`);
  }
}

module.exports = { handleChatImageUpload, serveChatImage, isValidChatImageFilename, MAX_FILE_SIZE, cleanupOldChatImages };
