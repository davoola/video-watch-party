const express = require('express');
const { scanVideos, scanDirContents } = require('./videoScanner');
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

module.exports = router;