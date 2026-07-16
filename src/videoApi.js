const express = require('express');
const fs = require('fs');
const path = require('path');
const { scanVideos, scanDirContents, scanDirDownloads, scanDirImages, resolveDownloadPath } = require('./videoScanner');
const { requireAuth } = require('./auth');

const router = express.Router();

// "阅读"功能只对 Markdown 文件开放，读取内容前先做个大小上限，避免有人在视频库里
// 塞一个几百 MB 的 .md 文件时，被整个读进内存造成压力（正常笔记/说明文档不可能这么大）。
const MAX_MD_READ_BYTES = 2 * 1024 * 1024; // 2MB

// dir 参数清洗：真正的安全边界是 videoScanner.js 里 resolveSubDir 的路径 containment
// 校验（path.resolve 之后判断是否仍落在 VIDEO_DIR 内），所以这里清洗得不严格也不会
// 造成路径穿越漏洞。但只去掉首尾单个斜杠、不处理连续斜杠（如 "a//b"）或 ".." 段，
// 输入本身不够干净——统一收敛到一个函数里，顺手把这些也处理掉，避免这类不规范输入
// 在 scanDirContents 等函数里被当成不同的 key 各自查一遍/各自报"目录不存在"。
function sanitizeDirParam(raw) {
  return (raw || '')
    .replace(/\\/g, '/')       // 统一成正斜杠
    .split('/')
    .filter((seg) => seg !== '' && seg !== '.' && seg !== '..') // 去掉空段、"."、".."
    .join('/');
}

// 原有接口：全量递归视频列表（早期版本首页用过，现在首页已经改用下面的 /api/browse
// 按目录分层浏览；这个接口目前没有前端调用方，保留是为了兼容可能存在的外部脚本/未来功能）
router.get('/api/videos', requireAuth, async (req, res) => {
  try {
    const videos = await scanVideos();
    res.json({
      videos: videos.map((v) => ({
        id: v.id,
        name: v.name,
        sizeBytes: v.sizeBytes,
        thumbnailUrl: `/video-thumbnail/${v.id}`,
      })),
    });
  } catch {
    res.status(500).json({ error: '扫描视频目录失败' });
  }
});

// 新接口：浏览指定目录的直接内容（子目录 + 视频）
router.get('/api/browse', requireAuth, async (req, res) => {
  const dir = sanitizeDirParam(req.query.dir);
  try {
    const result = await scanDirContents(dir);
    if (!result) {
      return res.status(404).json({ error: '目录不存在或无权访问' });
    }
    res.json({ dir, dirs: result.dirs, videos: result.videos });
  } catch {
    res.status(500).json({ error: '扫描目录失败' });
  }
});

// 视频列表页用：查询"当前浏览的目录"下有没有可下载的相关附件
// （docx/doc/xlsx/xls/pptx/ppt/pdf/md/txt/zip/7z/rar）。
// 根目录（VIDEO_DIR 本身）和任意子目录都可以查，dir 参数和 /api/browse 用法一致。
// 没有的话返回空数组，前端据此隐藏"相关附件"栏目。
router.get('/api/dir-docs', requireAuth, async (req, res) => {
  const dir = sanitizeDirParam(req.query.dir);
  try {
    const files = await scanDirDownloads(dir);
    if (files === null) {
      return res.status(404).json({ error: '目录不存在或无权访问' });
    }
    res.json({
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        sizeBytes: f.sizeBytes,
        downloadUrl: `/doc-download/${f.id}`,
      })),
    });
  } catch {
    res.status(500).json({ error: '扫描目录失败' });
  }
});

// "阅读"功能：只用于 Markdown 文件，返回文件原始文本内容（不是下载），前端拿到后用
// 已有的 renderMarkdown() 在页面内直接渲染成一个弹层，不用跳转/下载就能看全文。
// 复用 resolveDownloadPath 的 id 解析和路径穿越防护，额外只多加一条"必须是 .md"的限制。
router.get('/api/doc-content/:id', requireAuth, async (req, res) => {
  const fullPath = resolveDownloadPath(req.params.id);
  if (!fullPath) {
    return res.status(404).json({ error: '文件不存在或无权访问' });
  }
  if (path.extname(fullPath).toLowerCase() !== '.md') {
    return res.status(400).json({ error: '仅支持阅读 Markdown 文件' });
  }

  let stat;
  try {
    stat = await fs.promises.stat(fullPath);
  } catch {
    return res.status(404).json({ error: '文件不存在或无权访问' });
  }

  if (stat.size > MAX_MD_READ_BYTES) {
    return res.status(413).json({ error: `文件过大（超过 ${MAX_MD_READ_BYTES / 1024 / 1024}MB），无法在线阅读，请下载查看` });
  }

  try {
    const content = await fs.promises.readFile(fullPath, 'utf-8');
    res.json({ name: path.basename(fullPath), content });
  } catch {
    res.status(500).json({ error: '读取文件失败' });
  }
});

// 视频列表页用：查询"当前浏览的目录"下有没有图片，用于首页"图片库"栏目，
// 根目录和任意子目录都可以查（不递归查子文件夹），dir 参数和 /api/browse 用法一致。
// 这里返回的是该目录下的全部图片（不做数量截断）：首页缩略图只展示前 8 张是前端自己的
// 展示策略，但 lightbox 要能翻完这个文件夹下的所有图片，所以完整列表要交给前端。
// 没有图片的话返回空数组，前端据此隐藏"图片库"栏目。
router.get('/api/dir-images', requireAuth, async (req, res) => {
  const dir = sanitizeDirParam(req.query.dir);
  try {
    const result = await scanDirImages(dir);
    if (result === null) {
      return res.status(404).json({ error: '目录不存在或无权访问' });
    }
    res.json({
      images: result.images.map((img) => ({
        name: img.name,
        sizeBytes: img.sizeBytes,
        url: `/image-view/${img.id}`,
      })),
    });
  } catch {
    res.status(500).json({ error: '扫描目录失败' });
  }
});

module.exports = router;