const path = require('path');
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');

const config = require('./config');
config.validateConfig();

const { router: authRouter, requireAuth, requireAuthPage } = require('./auth');
const videoApiRouter = require('./videoApi');
const { streamVideo } = require('./videoStream');
const { handleChatImageUpload, serveChatImage } = require('./chatUpload');
const { getOrCreateThumbnail, checkFfmpegAvailable } = require('./thumbnail');
const { initSocket } = require('./socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 只有在确实跑在反向代理（nginx/Caddy 等）后面时才应该开启，见 config.js 里的说明。
// 这一行会让 Express 正确识别 X-Forwarded-Proto / X-Forwarded-For，
// 否则下面 cookie.secure: 'auto' 的判断、以及登录失败限流用到的 req.ip 都会读到错误的值。
if (config.TRUST_PROXY) {
  app.set('trust proxy', 1);
}

// ---- Session 配置 ----
// httpOnly: 阻止客户端 JS 读取 cookie，缓解 XSS 窃取 session 的风险
// sameSite=lax: 缓解 CSRF
// secure: 'auto' 让 express-session 在每次请求时动态判断"这次连接是否真的是 HTTPS"，
//   而不是简单地跟 NODE_ENV 绑定。如果写死 secure: true，但反向代理还没配好 HTTPS，
//   浏览器会直接拒绝存储这个 Cookie（规则：标记为 Secure 的 Cookie 只能在 HTTPS 下被接受），
//   表现为"登录请求明明成功了，却跳转不回首页"。
//   'auto' 配合上面的 trust proxy 设置，能在反向代理终止 HTTPS、内部转发 HTTP 给 Node 的
//   典型部署场景下正确工作：代理握手是 HTTPS 时才标记 Secure，否则不标记。
const sessionMiddleware = session({
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'vwp.sid', // 不用默认的 connect.sid，减少信息暴露
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 1000 * 60 * 60 * 12, // 12 小时
  },
});

app.use(sessionMiddleware);
// 让 Socket.IO 的 handshake 也能读取到同一份 session（需要 socket.io >= 4.6）
io.engine.use(sessionMiddleware);

app.use(express.json());

// 简单的安全响应头（没有引入额外依赖，按需手写关键几条）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ---- 认证相关 API（登录/登出/当前用户） ----
app.use(authRouter);

// ---- 视频列表 API ----
app.use(videoApiRouter);

// ---- 视频流（需要登录） ----
app.get('/video-stream/:id', requireAuth, streamVideo);

// ---- 聊天图片：上传与访问都需要登录 ----
app.post('/api/chat-upload', requireAuth, handleChatImageUpload);
app.get('/chat-image/:filename', requireAuth, serveChatImage);

// ---- 视频缩略图：懒加载生成，失败/不可用时返回 404，前端会自动退回默认图标 ----
app.get('/video-thumbnail/:id', requireAuth, async (req, res) => {
  try {
    const thumbPath = await getOrCreateThumbnail(req.params.id);
    if (!thumbPath) {
      return res.status(404).json({ error: '缩略图不可用' });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(thumbPath);
  } catch (err) {
    console.error('获取缩略图出错:', err);
    res.status(404).json({ error: '缩略图不可用' });
  }
});

// index.html 和 player.html 必须登录后才能访问
// 注意：这两条路由必须放在 express.static 之前，
// 否则静态文件中间件会直接把文件发出去，鉴权完全不会被触发。
app.get('/index.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/player.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'player.html'));
});

app.get('/', (req, res) => {
  res.redirect(req.session && req.session.user ? '/index.html' : '/login.html');
});

// ---- 静态资源 ----
// login.html、css、js 等允许匿名访问（登录页本身和登录页要用的脚本/样式必须能在未登录时加载）
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));

// 404
app.use((req, res) => {
  res.status(404).json({ error: '页面或资源不存在' });
});

// ---- Socket.IO 鉴权中间件：复用 HTTP session ----
io.use((socket, next) => {
  const req = socket.request;
  if (req.session && req.session.user) {
    socket.user = req.session.user;
    return next();
  }
  next(new Error('unauthorized'));
});

initSocket(io);

server.listen(config.PORT, () => {
  console.log(`视频同步观影服务已启动: http://localhost:${config.PORT}`);
  console.log(`视频目录: ${config.VIDEO_DIR}`);
  console.log(`运行模式: ${config.NODE_ENV}`);
  checkFfmpegAvailable(); // 提前检测一次并打印日志，结果会被缓存，不阻塞服务启动
});
