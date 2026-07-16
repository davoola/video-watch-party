const fs = require('fs');
const path = require('path');
const { resolveImagePath } = require('./videoScanner');

// 仅用于设置一个正确的 Content-Type，方便浏览器直接把响应当图片渲染。
const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// 图片库用：内嵌展示（首页 <img> 缩略图 / lightbox 大图），不是强制下载，
// 所以和 docDownload.js 不同，这里不设置 Content-Disposition: attachment。
async function viewImage(req, res) {
  const id = req.params.id;
  const fullPath = resolveImagePath(id);

  if (!fullPath) {
    return res.status(404).json({ error: '图片不存在或无权访问' });
  }

  try {
    await fs.promises.stat(fullPath);
  } catch {
    return res.status(404).json({ error: '图片不存在或无权访问' });
  }

  // 和 serveChatVoice 一样的原因：部分移动浏览器对体积较大的图片（高分辨率 PNG、
  // TIFF 之类）也会发 Range 探测请求，某些 HTTP 代理/CDN 也期望资源本身带
  // Accept-Ranges: bytes 才启用缓存；之前手写 createReadStream + pipe 不处理 Range，
  // 改用 Express 内置的 res.sendFile（底层 send 包）自动处理 Range/206/Accept-Ranges，
  // 不需要手写解析逻辑，也不容易有边界条件遗漏。
  res.sendFile(
    fullPath,
    {
      headers: {
        'Content-Type': getMimeType(fullPath),
        'Cache-Control': 'private, max-age=86400', // 私人影院场景下这些图片很少变动，允许浏览器缓存一段时间
      },
    },
    (err) => {
      if (err) {
        if (!res.headersSent) {
          res.status(err.status === 404 ? 404 : 500).json({ error: '图片不存在或读取失败' });
        } else {
          res.end();
        }
      }
    }
  );
}

module.exports = { viewImage };
