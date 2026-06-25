const fs = require('fs');
const path = require('path');
const { VIDEO_DIR } = require('./config');

const ALLOWED_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi']);

// 用相对路径的 base64url 编码作为视频 ID，避免在 URL 里直接暴露真实路径，
// 也避免文件名中的斜杠/特殊字符引发路由解析问题。
function encodeId(relPath) {
  return Buffer.from(relPath, 'utf-8').toString('base64url');
}

function decodeId(id) {
  return Buffer.from(id, 'base64url').toString('utf-8');
}

// 递归扫描 VIDEO_DIR，返回视频列表
function scanVideos() {
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

module.exports = { scanVideos, resolveVideoPath, encodeId, decodeId, ALLOWED_EXT };
