const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { spawn } = require('child_process');
const { CHAT_UPLOAD_DIR, CHAT_IMAGE_RETENTION_DAYS } = require('./config');
// 复用 thumbnail.js 里已经写好的 ffmpeg 探测逻辑（同一个 ffmpeg 二进制，没必要探测两遍）。
const { checkFfmpegAvailable } = require('./thumbnail');

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

  const ext = filename.split('.').pop();

  // 图片本身不像音频那样"不支持 Range 就完全放不出来"（<img> 不依赖 Range），但部分
  // 移动端浏览器/代理对体积较大的图片也会发 Range 探测，且 Accept-Ranges 是一部分
  // HTTP 缓存/代理判断"是否值得缓存"的参考信号之一——和 serveChatVoice/viewImage
  // 保持同样的实现方式，用 res.sendFile（底层 send 包）自动处理 Range/206/
  // Accept-Ranges，不用手写解析逻辑，代码风格也统一。
  res.sendFile(
    fullPath,
    {
      headers: {
        'Content-Type': EXT_MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400',
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

// ==================== 语音消息 ====================
// 和图片上传是同一套思路：只信任文件内容的魔数，不信任客户端声称的 MIME 类型；
// 校验通过后用随机文件名落盘，杜绝路径穿越/覆盖风险。
// 浏览器 MediaRecorder 常见产出格式：Chrome/Firefox 默认 audio/webm(opus)，
// Safari 通常是 audio/mp4(aac)；如果两边都不支持，前端会退回不提供录音功能。
const MAX_VOICE_FILE_SIZE = 8 * 1024 * 1024; // 8MB，配合前端 60 秒录音时长上限留出余量

const AUDIO_SIGNATURES = [
  // WebM/Matroska 容器的 EBML 头
  { ext: 'webm', mime: 'audio/webm', check: (buf) => buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3 },
  // Ogg 容器（Firefox 在部分平台上会用 audio/ogg;codecs=opus）
  { ext: 'ogg', mime: 'audio/ogg', check: (buf) => buf.slice(0, 4).toString('ascii') === 'OggS' },
  // MP4/M4A 容器：开头 4 字节是 box size，紧接着的 4 字节固定是 "ftyp"
  { ext: 'm4a', mime: 'audio/mp4', check: (buf) => buf.slice(4, 8).toString('ascii') === 'ftyp' },
];

function detectAudioType(buffer) {
  for (const sig of AUDIO_SIGNATURES) {
    if (buffer.length >= 12 && sig.check(buffer)) return sig;
  }
  return null;
}

const uploadVoice = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VOICE_FILE_SIZE, files: 1 },
}).single('voice');

// 把上传的语音转成 AAC/M4A。这一步是"跨设备能不能听到对方语音"的关键：
// 桌面端 Chrome/Firefox 的 MediaRecorder 默认只会录 WebM/Opus，而 iOS Safari（包括
// iOS 上所有基于 WebKit 的浏览器，不管叫什么名字）完全不支持解码 WebM 容器和 Opus
// 编码——这不是"服务端有没有支持 Range 请求"的问题，是格式本身放到 iOS 上就放不出来，
// 服务端怎么发都没用。AAC/M4A 是目前唯一能在桌面浏览器和 iOS Safari 之间通用的音频
// 格式，所以上传后统一转码成这个格式，不管录音端用的是什么浏览器，接收端都能播放。
//
// ffmpeg 是软依赖（和缩略图功能一样）：装了就转码；没装的话直接存原始格式，此时
// 只有"录音和播放用的是同一类浏览器引擎"时才能互相听到（比如两边都用桌面 Chrome），
// 跨生态（桌面录音 → iPhone 播放）会听不到——这一点在 README 里会注明。
function transcodeToM4a(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', inputPath,
      '-vn', // 只处理音频轨；正常输入本来就没有视频轨，这里是防御性参数
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath,
    ];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 转码退出码 ${code}: ${stderr.slice(-300)}`));
    });
  });
}

function handleChatVoiceUpload(req, res) {
  uploadVoice(req, res, async (err) => {
    try {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: `语音文件不能超过 ${MAX_VOICE_FILE_SIZE / 1024 / 1024}MB` });
        }
        return res.status(400).json({ error: '上传失败: ' + err.message });
      }

      if (!req.file) {
        return res.status(400).json({ error: '没有收到语音文件' });
      }

      const sig = detectAudioType(req.file.buffer);
      if (!sig) {
        return res.status(400).json({ error: '不支持的语音格式（仅支持浏览器录音生成的 WebM/Ogg/MP4 音频）' });
      }

      // 先把浏览器上传的原始格式落盘（随机文件名，避免用户可控内容影响路径）。
      const rawFilename = crypto.randomBytes(16).toString('hex') + '.' + sig.ext;
      const rawPath = path.join(CHAT_UPLOAD_DIR, rawFilename);
      await fs.promises.writeFile(rawPath, req.file.buffer);

      const ffmpegOk = await checkFfmpegAvailable();
      if (!ffmpegOk) {
        // 没有 ffmpeg：只能先原样提供，跨浏览器生态可能放不出来（见上面的注释）
        return res.json({ ok: true, url: `/chat-voice/${rawFilename}` });
      }

      // 转码产物用一个新的随机文件名（不能和 rawFilename 用同一个 id 再换扩展名——
      // 万一浏览器录的本来就是 .m4a，会导致 ffmpeg 的输入和输出是同一个文件，
      // 读写同一个文件在 ffmpeg 这类流式处理里是未定义行为，可能损坏文件）。
      const finalFilename = crypto.randomBytes(16).toString('hex') + '.m4a';
      const finalPath = path.join(CHAT_UPLOAD_DIR, finalFilename);

      try {
        await transcodeToM4a(rawPath, finalPath);
        fs.promises.unlink(rawPath).catch(() => {}); // 转码成功后原始文件就不需要了
        return res.json({ ok: true, url: `/chat-voice/${finalFilename}` });
      } catch (transcodeErr) {
        // 转码失败不等于上传失败——原始文件还在磁盘上，退回去用它，
        // 至少同类浏览器引擎之间还能听到，比整条消息发送失败要好。
        // 但 ffmpeg 失败前可能已经往 finalPath 写入了不完整的字节（比如输入损坏、
        // 进程中途被杀），这个文件不会被任何 URL 引用到，得主动清理掉，
        // 否则会一直占磁盘直到 30 天清理周期才被当成"过期文件"扫掉。
        fs.promises.unlink(finalPath).catch(() => {});
        console.error('[语音转码] 失败，回退使用原始格式:', transcodeErr.message);
        return res.json({ ok: true, url: `/chat-voice/${rawFilename}` });
      }
    } catch (writeErr) {
      console.error('保存聊天语音失败:', writeErr);
      if (!res.headersSent) res.status(500).json({ error: '服务器保存语音失败' });
    }
  });
}

const SAFE_VOICE_FILENAME_RE = /^[a-f0-9]{32}\.(webm|ogg|m4a)$/;

function isValidChatVoiceFilename(filename) {
  return typeof filename === 'string' && SAFE_VOICE_FILENAME_RE.test(filename);
}

const VOICE_EXT_MIME = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
};

function serveChatVoice(req, res) {
  const filename = req.params.filename;

  if (!isValidChatVoiceFilename(filename)) {
    return res.status(400).json({ error: '非法文件名' });
  }

  const fullPath = path.join(CHAT_UPLOAD_DIR, filename);

  const normalizedRoot = path.resolve(CHAT_UPLOAD_DIR) + path.sep;
  if (!path.resolve(fullPath).startsWith(normalizedRoot)) {
    return res.status(403).end();
  }

  const ext = filename.split('.').pop();

  // 音频和视频不一样：iOS Safari（以及大多数 Android 浏览器）在播放 <audio> 前会先发一个
  // 探测性的 Range 请求，如果服务器不认 Range、只会回 200 + 完整文件，Safari 会直接拒绝
  // 播放，表现为播放条永远转圈。之前这里手写 createReadStream + pipe，没有处理 Range，
  // 图片/文档不受影响（<img>、下载都不依赖 Range），但音频必须支持。
  // 改用 Express 内置的 res.sendFile（底层是 send 包）省去手写 Range/206/Content-Range
  // 解析的麻烦，官方实现更不容易有边界条件遗漏。传入的 fullPath 前面已经做过路径穿越
  // 校验，这里不需要再传 root 选项。
  res.sendFile(
    fullPath,
    {
      headers: {
        'Content-Type': VOICE_EXT_MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400',
      },
    },
    (err) => {
      if (err) {
        // sendFile 在文件不存在/被并发删除时也会走到这里；响应头是否已发出决定了
        // 还能不能用 status().end()，还是只能直接把连接结束掉
        if (!res.headersSent) {
          res.status(err.status === 404 ? 404 : 500).json({ error: '语音不存在或读取失败' });
        } else {
          res.end();
        }
      }
    }
  );
}

// 清理超过保留期限的聊天上传文件（图片 + 语音，两者都落在同一个 CHAT_UPLOAD_DIR 里，
// 共用同一套保留策略，所以这里不需要按文件类型分开处理，直接按目录里的每个文件判断即可）。
// 用异步 API（不是 readdirSync/statSync/unlinkSync），避免在文件数量较多时同步阻塞事件循环。
// CHAT_IMAGE_RETENTION_DAYS 设为 0 表示关闭自动清理（保留所有文件）。
async function cleanupOldChatUploads() {
  if (!CHAT_IMAGE_RETENTION_DAYS || CHAT_IMAGE_RETENTION_DAYS <= 0) return;

  const maxAgeMs = CHAT_IMAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const now = Date.now();

  let files;
  try {
    files = await fs.promises.readdir(CHAT_UPLOAD_DIR);
  } catch (err) {
    console.error('[聊天上传清理] 读取目录失败:', err.message);
    return;
  }

  let deletedCount = 0;
  for (const file of files) {
    const fullPath = path.join(CHAT_UPLOAD_DIR, file);
    try {
      const stat = await fs.promises.stat(fullPath);
      if (!stat.isFile()) continue;
      // 优先用创建时间（birthtime）判断"这个文件是不是该清理了"，而不是修改时间（mtime）——
      // 上传后的聊天图片/语音理论上不会再被修改，但像 rsync 备份恢复、touch 之类的操作会更新 mtime，
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
      console.error(`[聊天上传清理] 处理文件失败 ${file}:`, err.message);
    }
  }

  if (deletedCount > 0) {
    console.log(`[聊天上传清理] 已删除 ${deletedCount} 个超过 ${CHAT_IMAGE_RETENTION_DAYS} 天的聊天图片/语音文件`);
  }
}

module.exports = {
  handleChatImageUpload,
  serveChatImage,
  isValidChatImageFilename,
  MAX_FILE_SIZE,
  handleChatVoiceUpload,
  serveChatVoice,
  isValidChatVoiceFilename,
  MAX_VOICE_FILE_SIZE,
  cleanupOldChatUploads,
};
