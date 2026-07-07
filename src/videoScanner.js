const fs = require('fs');
const path = require('path');
const { VIDEO_DIR } = require('./config');

const ALLOWED_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi']);

// 视频同级目录下允许展示"下载链接"的文档 / 压缩包扩展名。
// 分成两个集合只是为了语义清晰（文档 vs 压缩包），实际处理逻辑完全一样，
// 对外统一按 DOWNLOADABLE_EXT 这个合集来判断。
const DOC_EXT = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf', '.md', '.txt']);
const ARCHIVE_EXT = new Set(['.zip', '.7z', '.rar']);
const DOWNLOADABLE_EXT = new Set([...DOC_EXT, ...ARCHIVE_EXT]);

// 视频列表缓存：避免每次 GET /api/videos 都重新递归遍历整个目录。
// 视频库通常不会频繁变动，30 秒的过期时间在"及时看到新视频"和"减少磁盘 I/O"之间是个合理折中。
const CACHE_TTL_MS = 30_000;
let cachedVideos = null;
let cachedAt = 0;

// 用相对路径的 base64url 编码作为视频 ID，避免在 URL 里直接暴露真实路径，
// 也避免文件名中的斜杠/特殊字符引发路由解析问题。
function encodeId(relPath) {
  return Buffer.from(relPath, 'utf-8').toString('base64url');
}

function decodeId(id) {
  return Buffer.from(id, 'base64url').toString('utf-8');
}

// 真正执行递归扫描的内部函数，不做任何缓存判断
function doScan() {
  const results = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`扫描目录失败 ${dir}:`, err.message);
      return;
    }

    for (const entry of entries) {
      // 跳过隐藏文件/目录（如 .DS_Store, .git）
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ALLOWED_EXT.has(ext)) {
          const relPath = path.relative(VIDEO_DIR, fullPath);
          let size = 0;
          try {
            size = fs.statSync(fullPath).size;
          } catch {
            // 文件可能在扫描过程中被删除，忽略
          }
          results.push({
            id: encodeId(relPath),
            name: entry.name,
            relPath,
            sizeBytes: size,
          });
        }
      }
    }
  }

  walk(VIDEO_DIR);

  // 按文件名排序，方便查看
  results.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return results;
}

// 对外暴露的扫描函数：命中缓存就直接返回，过期了才真正重新扫描磁盘。
// 加/删/改了视频文件，最多 30 秒内会在列表页体现出来。
function scanVideos() {
  const now = Date.now();
  if (cachedVideos && now - cachedAt < CACHE_TTL_MS) {
    return cachedVideos;
  }
  cachedVideos = doScan();
  cachedAt = now;
  return cachedVideos;
}

// 主动清空缓存，强制下一次调用 scanVideos() 重新扫描磁盘。
// 目前没有自动触发的地方，留作以后接入 fs.watch 或手动刷新接口时使用。
function invalidateVideoCache() {
  cachedVideos = null;
  cachedAt = 0;
}

// 将 ID 安全地解析为磁盘上的真实绝对路径。
// 核心防护：解析后的路径必须仍然位于 VIDEO_DIR 内部，否则视为非法（防路径穿越）。
function resolveVideoPath(id) {
  let relPath;
  try {
    relPath = decodeId(id);
  } catch {
    return null;
  }

  const fullPath = path.resolve(VIDEO_DIR, relPath);
  const normalizedRoot = path.resolve(VIDEO_DIR) + path.sep;

  if (!fullPath.startsWith(normalizedRoot)) {
    return null; // 试图跳出根目录，拒绝
  }

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return null;
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    return null; // 只允许访问视频扩展名的文件
  }

  return fullPath;
}

// 把"相对于 VIDEO_DIR 的子目录路径"安全地解析成磁盘上的绝对路径；
// 如果这个路径试图跳出 VIDEO_DIR（路径穿越攻击，如 dir=../../etc），返回 null。
// scanDirContents 和 scanDirDownloads 都是"读某个目录下的直接子项"，只是关心的
// 文件类型不同，这部分路径校验逻辑完全一样，提出来共用一份，避免以后改一处忘了改另一处。
function resolveSubDir(relDir) {
  const targetDir = relDir ? path.join(VIDEO_DIR, relDir) : VIDEO_DIR;

  const normalizedRoot = path.resolve(VIDEO_DIR);
  const normalizedTarget = path.resolve(targetDir);
  const isRoot = normalizedTarget === normalizedRoot;
  const isInside = normalizedTarget.startsWith(normalizedRoot + path.sep);
  if (!isRoot && !isInside) return null;

  return targetDir;
}

// 返回指定相对目录下的直接子目录和视频文件（不递归）
// relDir: 相对于 VIDEO_DIR 的路径，'' 表示根目录
function scanDirContents(relDir) {
  const targetDir = resolveSubDir(relDir);
  if (!targetDir) return null; // 路径穿越，拒绝

  let entries;
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const dirs = [];
  const videos = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(targetDir, entry.name);
    const entryRel = relDir ? relDir + '/' + entry.name : entry.name;

    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, relPath: entryRel });
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_EXT.has(ext)) {
        let size = 0;
        try { size = fs.statSync(fullPath).size; } catch {}
        videos.push({
          id: encodeId(entryRel),
          name: entry.name,
          sizeBytes: size,
          thumbnailUrl: `/video-thumbnail/${encodeId(entryRel)}`,
        });
      }
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  videos.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return { dirs, videos };
}

// 返回指定相对目录下的"相关附件"（不递归）：docx/doc/xlsx/xls/pptx/ppt/pdf/md/txt/zip/7z/rar。
// relDir: 相对于 VIDEO_DIR 的路径，'' 表示根目录；和 scanDirContents 是同一个目录，
// 只是这里只关心文档/压缩包，视频列表页浏览到某个目录时会同时调用这两个函数。
// 返回 null 表示目录本身不合法（不存在/越权），返回 [] 表示该目录下没有符合条件的文件。
function scanDirDownloads(relDir) {
  const targetDir = resolveSubDir(relDir);
  if (!targetDir) return null; // 路径穿越，拒绝

  let entries;
  try {
    entries = fs.readdirSync(targetDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // 跳过隐藏文件
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!DOWNLOADABLE_EXT.has(ext)) continue;

    const entryRelPath = relDir ? relDir + '/' + entry.name : entry.name;
    let size = 0;
    try {
      size = fs.statSync(path.join(targetDir, entry.name)).size;
    } catch {
      // 文件可能在扫描过程中被删除，忽略
    }

    files.push({
      id: encodeId(entryRelPath),
      name: entry.name,
      sizeBytes: size,
    });
  }

  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return files;
}

// 将下载链接里的 id 安全地解析为磁盘上的真实绝对路径，供 docDownload.js 使用。
// 逻辑和 resolveVideoPath 基本一致，只是允许的扩展名换成了 DOWNLOADABLE_EXT。
function resolveDownloadPath(id) {
  let relPath;
  try {
    relPath = decodeId(id);
  } catch {
    return null;
  }

  const fullPath = path.resolve(VIDEO_DIR, relPath);
  const normalizedRoot = path.resolve(VIDEO_DIR) + path.sep;

  if (!fullPath.startsWith(normalizedRoot)) {
    return null; // 试图跳出根目录，拒绝
  }

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    return null;
  }

  const ext = path.extname(fullPath).toLowerCase();
  if (!DOWNLOADABLE_EXT.has(ext)) {
    return null; // 只允许下载文档/压缩包扩展名的文件
  }

  return fullPath;
}

module.exports = {
  scanVideos,
  scanDirContents,
  resolveVideoPath,
  encodeId,
  decodeId,
  ALLOWED_EXT,
  invalidateVideoCache,
  scanDirDownloads,
  resolveDownloadPath,
  DOWNLOADABLE_EXT,
};