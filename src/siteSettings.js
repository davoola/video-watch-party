const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

// 运行时可变的站点名（启动时从 config 初始化）
let siteName = '私密影院';

function initSiteName(initial) {
  if (typeof initial === 'string' && initial.trim()) {
    siteName = initial.trim();
  }
}

function getSiteName() {
  return siteName;
}

function validateSiteName(name) {
  if (typeof name !== 'string') return '站点名称无效';
  const n = name.trim();
  if (!n) return '站点名称不能为空';
  if (n.length > 40) return '站点名称最多 40 个字符';
  return null;
}

// 更新内存中的站点名，并尽量同步写回 .env（若文件不存在则创建）
function setSiteName(name) {
  const err = validateSiteName(name);
  if (err) throw new Error(err);
  const n = name.trim();
  siteName = n;
  writeEnvSiteName(n);
  return siteName;
}

function writeEnvSiteName(value) {
  let content = '';
  try {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  } catch {
    content = '';
  }

  const line = `SITE_NAME=${value}`;
  if (/^SITE_NAME=.*$/m.test(content)) {
    content = content.replace(/^SITE_NAME=.*$/m, line);
  } else {
    content = content.trimEnd() + (content && !content.endsWith('\n') ? '\n' : '') + line + '\n';
  }

  const tmp = `${ENV_PATH}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, ENV_PATH);
}

module.exports = {
  initSiteName,
  getSiteName,
  setSiteName,
  validateSiteName,
};
