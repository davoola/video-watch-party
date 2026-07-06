const fs = require('fs');
const path = require('path');
const { resolveDownloadPath } = require('./videoScanner');

// 仅用于设置一个更友好的 Content-Type，浏览器/系统会依赖这个来决定用什么图标、
// 用什么程序打开；就算某个扩展名没在这里列出，也会退回 application/octet-stream，
// 不影响下载本身。
const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// 生成 Content-Disposition 需要的文件名。中文/特殊字符文件名不能直接放进 filename="..."，
// 这里同时给一个 ASCII 兜底名（老浏览器）和标准的 filename*=UTF-8''... 编码名（现代浏览器优先使用）。
function buildContentDisposition(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function downloadDoc(req, res) {
  const id = req.params.id;
  const fullPath = resolveDownloadPath(id);

  if (!fullPath) {
    return res.status(404).json({ error: '文件不存在或无权访问' });
  }

  let stat;
  try {
    stat = await fs.promises.stat(fullPath);
  } catch {
    return res.status(404).json({ error: '文件不存在或无权访问' });
  }

  res.setHeader('Content-Type', getMimeType(fullPath));
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Disposition', buildContentDisposition(path.basename(fullPath)));
  // 私人影院场景下这类文档很少变动，允许浏览器缓存一段时间，减少重复下载
  res.setHeader('Cache-Control', 'private, max-age=86400');

  const stream = fs.createReadStream(fullPath);
  stream.on('error', (err) => {
    console.error('文件下载读取错误:', err.message);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  stream.pipe(res);
}

module.exports = { downloadDoc };
