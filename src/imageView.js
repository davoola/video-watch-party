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

  let stat;
  try {
    stat = await fs.promises.stat(fullPath);
  } catch {
    return res.status(404).json({ error: '图片不存在或无权访问' });
  }

  res.setHeader('Content-Type', getMimeType(fullPath));
  res.setHeader('Content-Length', stat.size);
  // 私人影院场景下这些图片很少变动，允许浏览器缓存一段时间，减少重复请求
  res.setHeader('Cache-Control', 'private, max-age=86400');

  const stream = fs.createReadStream(fullPath);
  stream.on('error', (err) => {
    console.error('图片读取错误:', err.message);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  stream.pipe(res);
}

module.exports = { viewImage };
