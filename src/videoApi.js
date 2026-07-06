const express = require('express');
const { scanVideos, scanDirContents, scanDirDownloads } = require('./videoScanner');
const { requireAuth } = require('./auth');

const router = express.Router();

// 原有接口：全量视频列表（保留，socket.js 的同步仍会用到视频名等信息）
router.get('/api/videos', requireAuth, (req, res) => {
  try {
    const videos = scanVideos();
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
router.get('/api/browse', requireAuth, (req, res) => {
  const dir = (req.query.dir || '').replace(/\\/g, '/').replace(/^\/|\/$/g, '');
  const result = scanDirContents(dir);
  if (!result) {
    return res.status(404).json({ error: '目录不存在或无权访问' });
  }
  res.json({ dir, dirs: result.dirs, videos: result.videos });
});

// 视频列表页用：查询"当前浏览的目录"下有没有可下载的相关附件
// （docx/doc/xlsx/xls/pptx/ppt/pdf/md/txt/zip/7z/rar）。
// 根目录（VIDEO_DIR 本身）和任意子目录都可以查，dir 参数和 /api/browse 用法一致。
// 没有的话返回空数组，前端据此隐藏"相关附件"栏目。
router.get('/api/dir-docs', requireAuth, (req, res) => {
  const dir = (req.query.dir || '').replace(/\\/g, '/').replace(/^\/|\/$/g, '');
  const files = scanDirDownloads(dir);
  if (files === null) {
    return res.status(404).json({ error: '目录不存在或无权访问' });
  }
  res.json({
    files: files.map((f) => ({
      name: f.name,
      sizeBytes: f.sizeBytes,
      downloadUrl: `/doc-download/${f.id}`,
    })),
  });
});

module.exports = router;