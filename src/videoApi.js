const express = require('express');
const { scanVideos, scanDirContents, scanDirDownloads, scanDirImages } = require('./videoScanner');
const { requireAuth } = require('./auth');

const router = express.Router();

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

// 视频列表页用：查询"当前浏览的目录"下有没有图片，用于首页"图片库"栏目，
// 根目录和任意子目录都可以查（不递归查子文件夹），dir 参数和 /api/browse 用法一致。
// 这里返回的是该目录下的全部图片（不做数量截断）：首页缩略图只展示前 8 张是前端自己的
// 展示策略，但 lightbox 要能翻完这个文件夹下的所有图片，所以完整列表要交给前端。
// 没有图片的话返回空数组，前端据此隐藏"图片库"栏目。
router.get('/api/dir-images', requireAuth, (req, res) => {
  const dir = (req.query.dir || '').replace(/\\/g, '/').replace(/^\/|\/$/g, '');
  const result = scanDirImages(dir);
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
});

module.exports = router;