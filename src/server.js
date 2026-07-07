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
const { handleChatImageUpload, serveChatImage, cleanupOldChatImages } = require('./chatUpload');
const { getOrCreateThumbnail, checkFfmpegAvailable } = require('./thumbnail');
const { downloadDoc } = require('./docDownload');
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

  // Content-Security-Policy：纵深防御的最后一道——即使聊天的 Markdown 渲染本身
  // 已经做了 XSS 转义/协议白名单，CSP 能在那层防护意外失效时兜底。
  //
  // 各项取舍说明：
  // - script-src 'self'：不允许任何内联 <script> 或内联事件处理器（onclick= 之类）执行，
  //   只允许加载同源的 .js 文件。这要求页面里不能有内联脚本——已经确认 public/ 下
  //   所有 HTML 都没有内联 <script> 或内联事件属性了。
  // - style-src 'self' 'unsafe-inline'：这里保留了 'unsafe-inline'，没有做到最严格。
  //   原因：前端代码里大量用 element.style.xxx = '...' 直接设置样式（弹幕颜色/位置、
  //   聊天面板拖拽宽度、输入框自动撑高等），而不同浏览器对"JS 直接操作 CSSOM 是否受
  //   style-src 限制"的实现细节有过历史分歧，我没有真实浏览器环境能逐一验证所有目标
  //   浏览器的行为，贸然去掉 unsafe-inline 有概率静默破坏这些功能（且不容易第一时间
  //   发现），所以这里选择保守。CSS 注入本身的风险也明显小于脚本注入。
  //   如果你有条件用真实浏览器测试，可以尝试去掉 unsafe-inline 验证上述功能是否受影响。
  // - img-src 'self' https:：聊天支持 Markdown 图片语法 ![alt](url)，会加载任意 https
  //   外部图片，所以不能锁死成 'self'。
  // - connect-src 'self'：Socket.IO 的 WebSocket 连接是同源的。
  // - media-src 'self'：视频流来自 /video-stream/:id，同源。
  // - object-src 'none' / base-uri 'self'：没有用到 <object>/<embed>，禁掉降低攻击面；
  //   防止被注入的 <base> 标签篡改页面内相对链接的解析。
  // - frame-ancestors 'none'：CSP 标准里对应 X-Frame-Options 的现代写法，双重保险。
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' https:",
      "connect-src 'self'",
      "media-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );

  next();
});

// ---- 站点名称配置：不需要登录也能访问，因为登录页本身也要显示站点名称 ----
app.get('/api/site-config', (req, res) => {
  res.json({ siteName: config.SITE_NAME });
});

// ---- 认证相关 API（登录/登出/当前用户） ----
app.use(authRouter);

// ---- 视频列表 API ----
app.use(videoApiRouter);

// ---- 视频流（需要登录） ----
app.get('/video-stream/:id', requireAuth, streamVideo);

// ---- 相关附件下载（需要登录）：视频列表页"相关附件"区域用 ----
app.get('/doc-download/:id', requireAuth, downloadDoc);

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

// chat.html（独立聊天室页面）同样必须登录后才能访问，和 index.html / player.html 保持一致
// 之前这条路由被遗漏，导致 chat.html 会被下面的 express.static 直接放行，未登录也能打开页面本身
// （虽然 chat.js 里 loadMe() 请求 /api/me 失败后会把人跳转回登录页，实际数据不会泄露，
// 但页面本身对未登录用户可见仍然不符合其它页面的鉴权预期，这里补齐保持一致）
app.get('/chat.html', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'chat.html'));
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

  // 聊天图片清理：启动时先跑一次，之后每 24 小时跑一次。
  // CHAT_IMAGE_RETENTION_DAYS 设为 0 时，cleanupOldChatImages 内部会直接跳过，不做任何删除。
  cleanupOldChatImages();
  setInterval(cleanupOldChatImages, 24 * 60 * 60 * 1000).unref();
});
