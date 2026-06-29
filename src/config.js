require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const VIDEO_DIR = process.env.VIDEO_DIR;
const NODE_ENV = process.env.NODE_ENV || 'development';
const USERS_FILE = path.join(__dirname, '..', 'config', 'users.json');

// 是否信任反向代理（nginx/Caddy 等）传来的 X-Forwarded-* 头。
// 只有在确实有反向代理挡在前面时才应该开启——否则客户端可以直接伪造这些头，
// 冒充任意 IP 或冒充 HTTPS 连接，带来安全隐患。
// 直接用 npm start 跑、没有反向代理时，必须保持 false。
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

// 聊天图片保留天数：超过这个天数的上传图片会被定期清理脚本删除，避免磁盘无限增长。
// 默认 30 天（比常见的"7天"建议更宽松一些，毕竟私人聊天的图片可能有纪念意义，
// 不想删得太激进）。设为 0 表示关闭自动清理。
const CHAT_IMAGE_RETENTION_DAYS = (() => {
  const raw = parseInt(process.env.CHAT_IMAGE_RETENTION_DAYS, 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30;
})();

// 聊天图片上传目录：故意放在项目自己的 data 目录下，而不是 VIDEO_DIR 内部，
// 避免上传的图片被视频扫描逻辑误识别，也避免两类文件混在一起难以管理。
const CHAT_UPLOAD_DIR = path.join(__dirname, '..', 'data', 'chat-uploads');
fs.mkdirSync(CHAT_UPLOAD_DIR, { recursive: true });

// 视频缩略图缓存目录：同样独立存放，按需生成、长期缓存
const THUMBNAIL_DIR = path.join(__dirname, '..', 'data', 'thumbnails');
fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

// 启动时做基本的配置健全性检查，避免用默认/缺失配置裸跑上线
function validateConfig() {
  const errors = [];

  if (!SESSION_SECRET || SESSION_SECRET.length < 16) {
    errors.push(
      'SESSION_SECRET 未设置或太短（至少 16 位）。请在 .env 中设置一个随机长字符串。\n' +
      '  生成命令: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  if (!VIDEO_DIR) {
    errors.push('VIDEO_DIR 未设置，请在 .env 中指定视频目录的绝对路径。');
  } else if (!fs.existsSync(VIDEO_DIR)) {
    errors.push(`VIDEO_DIR 指定的目录不存在: ${VIDEO_DIR}`);
  } else if (!fs.statSync(VIDEO_DIR).isDirectory()) {
    errors.push(`VIDEO_DIR 不是一个目录: ${VIDEO_DIR}`);
  }

  if (errors.length > 0) {
    console.error('\n配置错误，服务无法启动：\n');
    errors.forEach((e) => console.error('  - ' + e));
    console.error('\n请检查项目根目录下的 .env 文件（可参考 .env.example）。\n');
    process.exit(1);
  }
}

module.exports = {
  PORT,
  SESSION_SECRET,
  VIDEO_DIR: VIDEO_DIR ? path.resolve(VIDEO_DIR) : null,
  NODE_ENV,
  USERS_FILE,
  CHAT_UPLOAD_DIR,
  THUMBNAIL_DIR,
  TRUST_PROXY,
  CHAT_IMAGE_RETENTION_DAYS,
  isProduction: NODE_ENV === 'production',
  validateConfig,
};
