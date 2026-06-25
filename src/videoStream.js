const fs = require('fs');
const path = require('path');
const { resolveVideoPath } = require('./videoScanner');

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// 弱 ETag：基于文件大小 + 修改时间，足够用来判断"文件是否变化过"，
// 不需要读取文件内容计算哈希（那样反而会拖慢响应）。
function makeEtag(stat) {
  return `"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
}

async function streamVideo(req, res) {
  const id = req.params.id;
  const fullPath = resolveVideoPath(id);

  if (!fullPath) {
    return res.status(404).json({ error: '视频不存在或无权访问' });
  }

  let stat;
  try {
    stat = await fs.promises.stat(fullPath);
  } catch (err) {
    return res.status(404).json({ error: '视频不存在或无权访问' });
  }

  const fileSize = stat.size;
  const mimeType = getMimeType(fullPath);
  const etag = makeEtag(stat);
  const range = req.headers.range;

  // 视频文件本身不会频繁变化，允许浏览器较长时间缓存已下载过的片段，
  // 减少重复拖动进度条/刷新页面时的重复网络传输。
  res.setHeader('Cache-Control', 'private, max-age=604800'); // 7 天
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());

  // 条件请求：如果浏览器已经缓存过这个资源且文件没变化，直接 304，不再传输任何数据
  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  if (!range) {
    // 没有 Range 头：返回整个文件（首次加载、或不支持 Range 的客户端）
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
      'Accept-Ranges': 'bytes',
    });
    const stream = fs.createReadStream(fullPath);
    stream.on('error', (err) => handleStreamError(err, res));
    stream.pipe(res);
    return;
  }

  // 解析 Range 头，例如 "bytes=12345-"
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    return;
  }

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= fileSize) {
    res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
    return;
  }

  const chunkSize = end - start + 1;

  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': mimeType,
  });

  const stream = fs.createReadStream(fullPath, { start, end });
  stream.on('error', (err) => handleStreamError(err, res));
  stream.pipe(res);
}

function handleStreamError(err, res) {
  console.error('视频流读取错误:', err.message);
  if (!res.headersSent) res.status(500).end();
  else res.end();
}

module.exports = { streamVideo };
