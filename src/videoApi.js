const express = require('express');
const { scanVideos } = require('./videoScanner');
const { requireAuth } = require('./auth');

const router = express.Router();

router.get('/api/videos', requireAuth, (req, res) => {
  try {
    const videos = scanVideos();
    res.json({
      videos: videos.map((v) => ({
        id: v.id,
        name: v.name,
        relPath: v.relPath,
        sizeBytes: v.sizeBytes,
        thumbnailUrl: `/video-thumbnail/${v.id}`,
      })),
    });
  } catch (err) {
    console.error('扫描视频出错:', err);
    res.status(500).json({ error: '扫描视频目录失败' });
  }
});

module.exports = router;
