const fs = require('fs');
const path = require('path');
const { VIDEO_DIR } = require('./config');

const ALLOWED_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.avi']);

// 首页"图片库"栏目允许展示的图片扩展名。故意不包含 .svg——SVG 文件里可以嵌入脚本，
// 如果被直接打开（而不是作为 <img> 内嵌）浏览器可能会执行其中的脚本，这里干脆整体排除，
// 不需要额外做内容嗅探。
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

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
// 缓存过期后，如果多个请求几乎同时到达，都会通过上面的缓存检查、各自发起一次完整的
// doScan()（一次递归目录遍历）。用这个变量把"正在进行中的扫描"记下来，后来者直接复用
// 同一个 Promise，而不是各自再触发一次全量扫描。
let scanInFlight = null;

// 用相对路径的 base64url 编码作为视频 ID，避免在 URL 里直接暴露真实路径，
// 也避免文件名中的斜杠/特殊字符引发路由解析问题。
function encodeId(relPath) {
  return Buffer.from(relPath, 'utf-8').toString('base64url');
}

function decodeId(id) {
  return Buffer.from(id, 'base64url').toString('utf-8');
}

// 真正执行递归扫描的内部函数，不做任何缓存判断。
// 用异步 fs.promises API 而不是 readdirSync/statSync，避免视频库目录层级深、文件多时，
// 递归遍历同步阻塞整个事件循环（30 秒缓存过期后，凑巧此时来的那个请求会等到这次扫描完）。
async function doScan() {
  const results = [];

  async function walk(dir) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.error(`扫描目录失败 ${dir}:`, err.message);
      return;
    }

    for (const entry of entries) {
      // 跳过隐藏文件/目录（如 .DS_Store, .git）
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ALLOWED_EXT.has(ext)) {
          const relPath = path.relative(VIDEO_DIR, fullPath);
          let size = 0;
          try {
            size = (await fs.promises.stat(fullPath)).size;
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

  await walk(VIDEO_DIR);

  // 按文件名排序，方便查看
  results.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return results;
}

// 对外暴露的扫描函数：命中缓存就直接返回，过期了才真正重新扫描磁盘。
// 加/删/改了视频文件，最多 30 秒内会在列表页体现出来。
async function scanVideos() {
  const now = Date.now();
  if (cachedVideos && now - cachedAt < CACHE_TTL_MS) {
    return cachedVideos;
  }
  if (scanInFlight) {
    return scanInFlight; // 复用正在进行中的扫描，避免并发雪崩
  }
  scanInFlight = doScan()
    .then((result) => {
      cachedVideos = result;
      cachedAt = Date.now();
      scanInFlight = null;
      return result;
    })
    .catch((err) => {
      scanInFlight = null;
      throw err;
    });
  return scanInFlight;
}

// 主动清空缓存，强制下一次调用 scanVideos() 重新扫描磁盘。
// 目前没有自动触发的地方，留作以后接入 fs.watch 或手动刷新接口时使用。
function invalidateVideoCache() {
  cachedVideos = null;
  cachedAt = 0;
}

// 把 id 安全地解析成磁盘上的真实绝对路径"候选值"，供 resolveVideoPath / resolveDownloadPath /
// resolveImagePath 共用——三者的逻辑除了"允许的扩展名集合"不同之外完全一样：
// 解码 id → 校验没有跳出 VIDEO_DIR → 校验扩展名在白名单内。
//
// 注意：这里特意不做 fs.existsSync/fs.statSync 同步磁盘检查。三个调用方
// （videoStream.js / docDownload.js / imageView.js，以及 socket.js 的 join-room）
// 拿到这里返回的路径后，自己都会紧接着做一次异步的 fs.promises.stat 来真正确认文件存在、
// 拿到文件大小等信息；这里如果再做一遍同步检查，纯粹是多阻塞一次事件循环，
// 尤其 /video-stream/:id 这种高频路由（拖进度条时浏览器会发大量 Range 请求）上影响会被放大。
// "文件到底存不存在"这件事，交给调用方那次异步 stat 兜底即可。
function resolveSafePath(id, allowedExts) {
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

  const ext = path.extname(fullPath).toLowerCase();
  if (!allowedExts.has(ext)) {
    return null; // 扩展名不在白名单内
  }

  return fullPath;
}

// 将 ID 安全地解析为磁盘上的真实绝对路径。
// 核心防护：解析后的路径必须仍然位于 VIDEO_DIR 内部，否则视为非法（防路径穿越）。
function resolveVideoPath(id) {
  return resolveSafePath(id, ALLOWED_EXT);
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

// 给"单层目录扫描"结果加一个很短的 TTL 缓存：用户在首页快速切换目录时，每次切换都会
// 同时触发 /api/browse + /api/dir-docs + /api/dir-images 三个请求，各自都要重新扫描一次
// 同一个目录。和 scanVideos() 的 30 秒缓存比，这里特意给了更短的过期时间——目录列表比
// "整个视频库"更新得更频繁（用户随时可能往里面加文件/图片/文档），缓存时间不宜太长。
const DIR_CACHE_TTL_MS = 15_000;

// 给定一个"relDir -> 结果"的异步函数，返回一个带缓存的版本；每个目录各自独立缓存，
// 互不影响（用 relDir 本身当 key）。scanDirContents / scanDirDownloads / scanDirImages
// 三个函数分别调用这个包装器各自生成一份缓存，不会互相串。
// 除了缓存本身，这里还做了"进行中请求去重"（in-flight dedup）：缓存过期的瞬间，如果
// 好几个请求几乎同时到达同一个目录（比如切换目录时 /api/browse + /api/dir-docs +
// /api/dir-images 一起打过来，或者两个人同时浏览到同一个新目录），异步版本不会像
// 之前的同步版本那样天然串行，如果不处理，会各自触发一次独立的目录扫描——用一个
// Map 记录"这个目录现在是否已经有一次扫描正在进行"，后来者直接复用同一个 Promise。
function memoizeDirScan(fn) {
  const cache = new Map(); // relDir -> { value, cachedAt }
  const inFlight = new Map(); // relDir -> 正在进行中的扫描 Promise
  return function cachedFn(relDir) {
    const key = relDir || '';
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && now - cached.cachedAt < DIR_CACHE_TTL_MS) {
      return Promise.resolve(cached.value);
    }
    if (inFlight.has(key)) {
      return inFlight.get(key);
    }
    const promise = fn(relDir)
      .then((value) => {
        cache.set(key, { value, cachedAt: Date.now() });
        inFlight.delete(key);
        return value;
      })
      .catch((err) => {
        inFlight.delete(key);
        throw err;
      });
    inFlight.set(key, promise);
    return promise;
  };
}

// 返回指定相对目录下的直接子目录和视频文件（不递归）
// relDir: 相对于 VIDEO_DIR 的路径，'' 表示根目录
//
// 之前这三个 *Uncached 函数（这个 + scanDirDownloadsUncached + scanDirImagesUncached）
// 用的是 readdirSync/statSync，和文件里其它地方"一律用异步 fs.promises API，避免同步
// 阻塞事件循环"的原则不一致——15 秒的目录缓存让实际命中率很高，但缓存过期后的第一个
// 请求仍然会同步卡住整个事件循环，期间连视频流的 Range 请求都要等它扫完才能继续。
// 改成异步之后，调用方（videoApi.js 的三个路由）也相应改成 await。
async function scanDirContentsUncached(relDir) {
  const targetDir = resolveSubDir(relDir);
  if (!targetDir) return null; // 路径穿越，拒绝

  let entries;
  try {
    entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
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
        try { size = (await fs.promises.stat(fullPath)).size; } catch {}
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
const scanDirContents = memoizeDirScan(scanDirContentsUncached);

// 返回指定相对目录下的"相关附件"（不递归）：docx/doc/xlsx/xls/pptx/ppt/pdf/md/txt/zip/7z/rar。
// relDir: 相对于 VIDEO_DIR 的路径，'' 表示根目录；和 scanDirContents 是同一个目录，
// 只是这里只关心文档/压缩包，视频列表页浏览到某个目录时会同时调用这两个函数。
// 返回 null 表示目录本身不合法（不存在/越权），返回 [] 表示该目录下没有符合条件的文件。
async function scanDirDownloadsUncached(relDir) {
  const targetDir = resolveSubDir(relDir);
  if (!targetDir) return null; // 路径穿越，拒绝

  let entries;
  try {
    entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
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
      size = (await fs.promises.stat(path.join(targetDir, entry.name))).size;
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
const scanDirDownloads = memoizeDirScan(scanDirDownloadsUncached);

// 将下载链接里的 id 安全地解析为磁盘上的真实绝对路径，供 docDownload.js 使用。
// 逻辑和 resolveVideoPath 基本一致，只是允许的扩展名换成了 DOWNLOADABLE_EXT。
function resolveDownloadPath(id) {
  return resolveSafePath(id, DOWNLOADABLE_EXT);
}

// 返回指定相对目录下的全部图片（不递归），供首页"图片库"栏目使用。
// relDir: 相对于 VIDEO_DIR 的路径，'' 表示根目录；和 scanDirContents / scanDirDownloads 是
// 同一个目录，只是这里只关心图片。
// 注意这里特意不做数量截断——首页缩略图只展示前 8 张是前端的展示策略，
// 但 lightbox 要能左右/上下键翻完"这个文件夹下的所有图片"，所以后端要把完整列表都给前端，
// 由前端自己决定"缩略图只画 8 个、lightbox 可以翻全部"。
// 返回 null 表示目录本身不合法（不存在/越权），返回 { images: [] } 表示该目录下没有图片。
async function scanDirImagesUncached(relDir) {
  const targetDir = resolveSubDir(relDir);
  if (!targetDir) return null; // 路径穿越，拒绝

  let entries;
  try {
    entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const allImages = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // 跳过隐藏文件
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;

    const entryRelPath = relDir ? relDir + '/' + entry.name : entry.name;
    let size = 0;
    try {
      size = (await fs.promises.stat(path.join(targetDir, entry.name))).size;
    } catch {
      // 文件可能在扫描过程中被删除，忽略
    }

    allImages.push({
      id: encodeId(entryRelPath),
      name: entry.name,
      sizeBytes: size,
    });
  }

  allImages.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return { images: allImages };
}
const scanDirImages = memoizeDirScan(scanDirImagesUncached);

// 将图片查看链接里的 id 安全地解析为磁盘上的真实绝对路径，供 imageView.js 使用。
// 逻辑和 resolveDownloadPath 基本一致，只是允许的扩展名换成了 IMAGE_EXT。
function resolveImagePath(id) {
  return resolveSafePath(id, IMAGE_EXT);
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
  scanDirImages,
  resolveImagePath,
  IMAGE_EXT,
};