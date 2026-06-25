// 用 ffmpeg 从视频中截一帧作为列表页的预览图，生成后缓存到磁盘，
// 之后同一个视频直接读缓存，不会每次都重新调用 ffmpeg。
//
// 设计成"软依赖"：如果服务器没装 ffmpeg，缩略图功能整体跳过，
// 不会影响登录、播放、聊天等其他功能——只是列表页退回显示默认的 ▶ 图标。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { THUMBNAIL_DIR, VIDEO_DIR } = require('./config');
const { resolveVideoPath } = require('./videoScanner');

let ffmpegAvailable = null; // null = 还没检测过；true/false = 检测结果缓存
let ffmpegCheckPromise = null;

function checkFfmpegAvailable() {
  if (ffmpegCheckPromise) return ffmpegCheckPromise;

  ffmpegCheckPromise = new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    let resolved = false;

    proc.on('error', () => {
      if (resolved) return;
      resolved = true;
      ffmpegAvailable = false;
      console.warn(
        '[缩略图] 未检测到 ffmpeg，视频预览图功能已自动关闭（不影响播放/聊天等其他功能）。\n' +
        '         如需启用预览图，请在服务器上安装 ffmpeg（如: apt install ffmpeg）。'
      );
      resolve(false);
    });

    proc.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      ffmpegAvailable = code === 0;
      if (ffmpegAvailable) {
        console.log('[缩略图] 已检测到 ffmpeg，视频预览图功能可用。');
      }
      resolve(ffmpegAvailable);
    });
  });

  return ffmpegCheckPromise;
}

// 用视频的真实路径 + 修改时间 + 大小算缓存 key，
// 这样如果用户替换了同名视频文件，缩略图会自动失效重新生成，而不是用旧图。
function getCacheKey(fullPath, stat) {
  const hash = crypto
    .createHash('sha1')
    .update(fullPath + ':' + stat.mtimeMs + ':' + stat.size)
    .digest('hex');
  return hash + '.jpg';
}

const inflightGenerations = new Map(); // cacheKey -> Promise，避免同一个视频被并发重复生成

function generateThumbnail(fullPath, outputPath) {
  return new Promise((resolve, reject) => {
    // -ss 放在 -i 之前可以用 ffmpeg 的快速 seek（基于关键帧跳转），
    // 对大文件也能很快截到帧，不需要解码整个视频。
    // 取视频开始后的第 3 秒，比第 0 秒更可能避开片头黑屏/Logo。
    const args = [
      '-y', // 覆盖已存在的输出文件
      '-ss', '3',
      '-i', fullPath,
      '-frames:v', '1',
      '-vf', 'scale=320:-1',
      '-q:v', '4',
      outputPath,
    ];

    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-300)}`));
      }
    });
  });
}

// 返回缩略图文件的绝对路径；如果还没生成过，会先生成再返回。
// ffmpeg 不可用、视频无效、生成失败等情况都返回 null（调用方据此走兜底逻辑）。
async function getOrCreateThumbnail(videoId) {
  if (ffmpegAvailable === null) {
    await checkFfmpegAvailable();
  }
  if (ffmpegAvailable === false) return null;

  const fullPath = resolveVideoPath(videoId);
  if (!fullPath) return null;

  let stat;
  try {
    stat = await fs.promises.stat(fullPath);
  } catch {
    return null;
  }

  const cacheKey = getCacheKey(fullPath, stat);
  const cachePath = path.join(THUMBNAIL_DIR, cacheKey);

  if (fs.existsSync(cachePath)) {
    return cachePath;
  }

  // 同一个视频如果同时来了好几个请求（比如列表页一次性请求多张缩略图时网络重试），
  // 不要并发跑多个 ffmpeg 进程处理同一个文件，复用同一个 Promise。
  if (inflightGenerations.has(cacheKey)) {
    try {
      await inflightGenerations.get(cacheKey);
      return fs.existsSync(cachePath) ? cachePath : null;
    } catch {
      return null;
    }
  }

  const tmpPath = path.join(THUMBNAIL_DIR, `tmp-${process.pid}-${cacheKey}`);
  const genPromise = generateThumbnail(fullPath, tmpPath)
    .then(() => fs.promises.rename(tmpPath, cachePath))
    .catch((err) => {
      console.warn(`[缩略图] 生成失败 (${path.basename(fullPath)}): ${err.message}`);
      fs.promises.unlink(tmpPath).catch(() => {});
      throw err;
    })
    .finally(() => {
      inflightGenerations.delete(cacheKey);
    });

  inflightGenerations.set(cacheKey, genPromise);

  try {
    await genPromise;
    return cachePath;
  } catch {
    return null;
  }
}

module.exports = { getOrCreateThumbnail, checkFfmpegAvailable };
