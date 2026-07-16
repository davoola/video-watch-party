const contentEl = document.getElementById('content');
const meText = document.getElementById('meText');
const logoutBtn = document.getElementById('logoutBtn');
const presenceBanner = document.getElementById('presenceBanner');
const breadcrumbEl = document.getElementById('breadcrumb');
const brandLogo = document.getElementById('brandLogo');
const attachmentsEl = document.getElementById('attachments');
const attachmentsListEl = document.getElementById('attachmentsList');
const galleryEl = document.getElementById('gallery');
const galleryGridEl = document.getElementById('galleryGrid');
const mdReaderEl = document.getElementById('mdReader');
const mdReaderTitleEl = document.getElementById('mdReaderTitle');
const mdReaderBodyEl = document.getElementById('mdReaderBody');
const mdReaderCloseBtn = document.getElementById('mdReaderClose');

brandLogo.addEventListener('error', () => { brandLogo.style.display = 'none'; });

let myUsername = '';
let currentDir = ''; // 当前目录，'' = 根目录
let galleryImages = []; // 当前目录图片库列表（lightbox 翻页要用到）

function formatSize(bytes) {
  if (!bytes) return '未知大小';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(1) + ' MB';
}

async function loadMe() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) { window.location.href = '/login.html'; return; }
    const data = await res.json();
    myUsername = data.username;
    meText.textContent = `你好，${myUsername}`;
  } catch {
    window.location.href = '/login.html';
  }
}

// ---- 面包屑 ----
function renderBreadcrumb(dir) {
  const parts = dir ? dir.split('/') : [];
  let html = `<button class="crumb-btn" data-dir="">🏠 根目录</button>`;
  let acc = '';
  parts.forEach((part, i) => {
    acc = acc ? acc + '/' + part : part;
    html += `<span class="crumb-sep">›</span>`;
    if (i === parts.length - 1) {
      html += `<span class="crumb-current">${escapeHtml(part)}</span>`;
    } else {
      html += `<button class="crumb-btn" data-dir="${escapeAttr(acc)}">${escapeHtml(part)}</button>`;
    }
  });
  breadcrumbEl.innerHTML = html;
  breadcrumbEl.querySelectorAll('.crumb-btn').forEach((btn) => {
    btn.addEventListener('click', () => browseDir(btn.dataset.dir));
  });
}

// ---- 目录浏览 ----
async function browseDir(dir) {
  currentDir = dir;
  renderBreadcrumb(dir);
  contentEl.innerHTML = '<div class="empty-state">加载中…</div>';
  attachmentsEl.hidden = true; // 切换目录时先隐藏，等新目录的附件查询结果回来再决定是否显示
  galleryEl.hidden = true; // 图片库同理，先隐藏，等新目录的查询结果回来再决定是否显示
  try {
    const qs = dir ? '?dir=' + encodeURIComponent(dir) : '';
    const res = await fetch('/api/browse' + qs);
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    const data = await res.json();
    renderDirContents(data.dirs || [], data.videos || []);
  } catch {
    contentEl.innerHTML = '<div class="empty-state">加载目录失败，请刷新重试</div>';
  }
  loadGallery(dir);
  loadAttachments(dir);
}

function renderDirContents(dirs, videos) {
  if (dirs.length === 0 && videos.length === 0) {
    contentEl.innerHTML = '<div class="empty-state">这个目录里暂无视频或子目录</div>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'video-grid';

  // 先渲染文件夹
  dirs.forEach((d) => {
    const card = document.createElement('div');
    card.className = 'video-card folder-card';
    card.innerHTML = `
      <div class="thumb folder-thumb">
        <span class="folder-icon">📁</span>
      </div>
      <div class="name">${escapeHtml(d.name)}</div>
      <div class="meta">文件夹</div>
    `;
    card.addEventListener('click', () => browseDir(d.relPath));
    grid.appendChild(card);
  });

  // 再渲染视频
  videos.forEach((v) => {
    const card = document.createElement('div');
    card.className = 'video-card';
    card.innerHTML = `
      <div class="thumb">
        <img class="thumb-img" src="${escapeAttr(v.thumbnailUrl)}" alt="" loading="lazy">
        <span class="thumb-fallback">▶</span>
        <span class="thumb-play-overlay">▶</span>
      </div>
      <div class="name">${escapeHtml(v.name)}</div>
      <div class="meta">${formatSize(v.sizeBytes)}</div>
    `;
    const img = card.querySelector('.thumb-img');
    const thumbEl = card.querySelector('.thumb');
    img.addEventListener('error', () => thumbEl.classList.add('thumb-fallback-active'));
    img.addEventListener('load', () => thumbEl.classList.add('thumb-loaded'));
    card.addEventListener('click', () => goToPlayer(v.id, v.name));
    grid.appendChild(card);
  });

  contentEl.innerHTML = '';
  contentEl.appendChild(grid);
}

// ---- 图片库（当前浏览目录下的图片，最多 8 张）----
// 请求"当前目录"的图片列表；用 requestDir 记录发起请求时的目录，逻辑和 loadAttachments 一样：
// 结果回来时如果用户已经切换到别的目录了，就丢弃这次结果，避免图片库显示错目录的内容。
async function loadGallery(requestDir) {
  try {
    const qs = requestDir ? '?dir=' + encodeURIComponent(requestDir) : '';
    const res = await fetch('/api/dir-images' + qs);
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    if (!res.ok) return;
    const data = await res.json();
    if (requestDir !== currentDir) return; // 目录已经切换，结果过期，丢弃
    renderGallery(data.images || []);
  } catch {
    // 图片库加载失败不影响正常看视频列表，静默忽略即可
  }
}

function renderGallery(images) {
  // 全量列表存起来给 lightbox 用（左右/上下键要能翻完这个目录下的所有图片，
  // 不只是首页展示出来的这 8 张），首页缩略图只画前 8 张。
  galleryImages = images;

  if (!images.length) {
    galleryEl.hidden = true;
    galleryGridEl.innerHTML = '';
    return;
  }

  const thumbnails = images.slice(0, 8);

  galleryGridEl.innerHTML = '';
  thumbnails.forEach((img, index) => {
    // 复用 .video-card / .thumb 的结构和尺寸，保证图片卡片和视频卡片大小完全一致；
    // 图片本身就是内容，不需要 .thumb-img 那套"异步生成缩略图"的淡入/兜底逻辑。
    const card = document.createElement('div');
    card.className = 'video-card gallery-card';
    card.innerHTML = `
      <div class="thumb">
        <img class="gallery-thumb-img" src="${escapeAttr(img.url)}" alt="" loading="lazy">
      </div>
      <div class="name">${escapeHtml(img.name)}</div>
      <div class="meta">${formatSize(img.sizeBytes)}</div>
    `;
    // index 是"缩略图在 thumbnails 里的下标"，因为 thumbnails 是 images 的前 8 项，
    // 所以这个下标在完整的 galleryImages 数组里也是同一个位置，可以直接用来打开 lightbox。
    card.addEventListener('click', () => openGalleryLightbox(index));
    galleryGridEl.appendChild(card);
  });

  galleryEl.hidden = false;
}

// 图片库的 lightbox 交互（开关/翻页/键盘）统一由 public/js/lightbox.js 里的
// 通用 Lightbox 组件负责，这里只需要把"这个目录下的全部图片"转换成它要的格式传进去，
// 这样左右/上下键翻的就是完整列表，不受首页只展示 8 张缩略图的限制。
function openGalleryLightbox(startIndex) {
  const items = galleryImages.map((img) => ({ url: img.url, caption: img.name }));
  Lightbox.open(items, startIndex);
}

// ---- 相关附件（当前浏览目录下的 docx/xlsx/pptx/pdf/md/txt/压缩包等） ----
// 内置的文件类型图标：按扩展名分组给一个简单的色块 + 文字标签，不依赖任何外部图片资源。
const FILE_ICON_MAP = {
  doc: { label: 'DOC', color: '#3b6fd6' },
  docx: { label: 'DOC', color: '#3b6fd6' },
  xls: { label: 'XLS', color: '#1e8e5a' },
  xlsx: { label: 'XLS', color: '#1e8e5a' },
  ppt: { label: 'PPT', color: '#d9622b' },
  pptx: { label: 'PPT', color: '#d9622b' },
  pdf: { label: 'PDF', color: '#d64545' },
  md: { label: 'MD', color: '#6a7280' },
  txt: { label: 'TXT', color: '#6a7280' },
  zip: { label: 'ZIP', color: '#c9a227' },
  '7z': { label: '7Z', color: '#c9a227' },
  rar: { label: 'RAR', color: '#c9a227' },
};

// 生成"文件图标"的 SVG：一张带折角的纸 + 居中的扩展名文字。
// 这里的输入只来自上面写死的 FILE_ICON_MAP（不是用户输入），拼进 innerHTML 是安全的。
function fileIconSvg(ext) {
  const info = FILE_ICON_MAP[ext] || { label: ext.toUpperCase().slice(0, 3), color: '#6a7280' };
  return `<svg viewBox="0 0 32 32" width="28" height="28" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M7 2h13l6 6v22a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="${info.color}"/>
    <path d="M20 2v6h6" fill="rgba(255,255,255,0.55)"/>
    <text x="16" y="23" font-size="8" font-family="Arial, sans-serif" font-weight="700" fill="#fff" text-anchor="middle">${info.label}</text>
  </svg>`;
}

// 请求"当前目录"的相关附件列表；用 requestDir 记录发起请求时的目录，
// 结果回来时如果用户已经切换到别的目录了，就丢弃这次结果，避免附件栏目显示错目录的内容。
async function loadAttachments(requestDir) {
  try {
    const qs = requestDir ? '?dir=' + encodeURIComponent(requestDir) : '';
    const res = await fetch('/api/dir-docs' + qs);
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    if (!res.ok) return;
    const data = await res.json();
    if (requestDir !== currentDir) return; // 目录已经切换，结果过期，丢弃
    renderAttachments(data.files || []);
  } catch {
    // 附件加载失败不影响正常看视频列表，静默忽略即可
  }
}

function renderAttachments(files) {
  if (!files.length) {
    attachmentsEl.hidden = true;
    attachmentsListEl.innerHTML = '';
    return;
  }

  attachmentsListEl.innerHTML = '';
  files.forEach((f) => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();

    const row = document.createElement('div');
    row.className = 'attachment-item';

    const icon = document.createElement('span');
    icon.className = 'attachment-icon';
    icon.innerHTML = fileIconSvg(ext);

    const info = document.createElement('div');
    info.className = 'attachment-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'attachment-name';
    nameEl.textContent = f.name;
    nameEl.title = f.name;

    const sizeEl = document.createElement('div');
    sizeEl.className = 'attachment-size';
    sizeEl.textContent = formatSize(f.sizeBytes);

    info.appendChild(nameEl);
    info.appendChild(sizeEl);

    row.appendChild(icon);
    row.appendChild(info);

    // Markdown 文件额外提供一个"阅读"入口：不下载，直接在页面内弹层显示渲染后的全文，
    // 和下载链接并列放在一起，放在下载前面（先阅读、需要的话再下载）。
    if (ext === 'md') {
      const readBtn = document.createElement('button');
      readBtn.type = 'button';
      readBtn.className = 'attachment-read';
      readBtn.textContent = '阅读';
      readBtn.addEventListener('click', () => openMarkdownReader(f));
      row.appendChild(readBtn);
    }

    const link = document.createElement('a');
    link.className = 'attachment-download';
    link.href = f.downloadUrl;
    link.download = f.name; // 提示浏览器按下载而不是导航打开
    link.textContent = '下载';
    row.appendChild(link);

    attachmentsListEl.appendChild(row);
  });

  attachmentsEl.hidden = false;
}

// ---- Markdown 在线阅读 ----
// 复用聊天气泡的 .msg .bubble 这套 Markdown 排版样式（标题/列表/表格/代码块等），
// 弹层本身只负责外层的浮层/滚动容器，不需要重新写一遍 Markdown 排版 CSS。
async function openMarkdownReader(file) {
  mdReaderTitleEl.textContent = file.name;
  mdReaderBodyEl.innerHTML = '<p class="md-p">正在加载...</p>';
  mdReaderEl.hidden = false;
  document.body.style.overflow = 'hidden';

  try {
    const res = await fetch('/api/doc-content/' + file.id);
    const data = await res.json();
    if (!res.ok) {
      mdReaderBodyEl.innerHTML = `<p class="md-p">${escapeHtml(data.error || '加载失败')}</p>`;
      return;
    }
    mdReaderBodyEl.innerHTML = renderMarkdown(data.content);
  } catch {
    mdReaderBodyEl.innerHTML = '<p class="md-p">加载失败，请检查网络后重试</p>';
  }
}

function closeMarkdownReader() {
  mdReaderEl.hidden = true;
  mdReaderBodyEl.innerHTML = '';
  document.body.style.overflow = '';
}

mdReaderCloseBtn.addEventListener('click', closeMarkdownReader);
// 点击遮罩空白处（弹层本体之外）也关闭，和图片 lightbox 的交互习惯保持一致
mdReaderEl.addEventListener('click', (e) => {
  if (e.target === mdReaderEl) closeMarkdownReader();
});
document.addEventListener('keydown', (e) => {
  if (!mdReaderEl.hidden && e.key === 'Escape') closeMarkdownReader();
});

// Markdown 代码块右上角的"复制"按钮，和聊天页面用的是同一套事件委托思路
// （CSP script-src 'self' 不允许内联 onclick），这里监听在阅读弹层的内容容器上。
async function copyCodeFromButton(button) {
  const wrap = button.closest('.md-code-block-wrap');
  const codeEl = wrap && wrap.querySelector('code');
  if (!codeEl) return;

  const text = codeEl.textContent;
  const originalLabel = button.textContent;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    button.textContent = '已复制';
    button.classList.add('copied');
  } catch {
    button.textContent = '复制失败';
  }

  setTimeout(() => {
    button.textContent = originalLabel;
    button.classList.remove('copied');
  }, 1500);
}

mdReaderBodyEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.md-copy-btn');
  if (btn) copyCodeFromButton(btn);
});



function goToPlayer(id, name) {
  if (id === '__lobby_chat__') {
    window.location.href = '/chat.html';
    return;
  }
  window.location.href = `/player.html?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
}

// ---- 退出 ----
logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ---- 大厅在线状态 ----
const socket = io();
socket.on('connect', () => { socket.emit('enter-lobby'); });
socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') window.location.href = '/login.html';
});
socket.on('lobby-presence', ({ users }) => { renderPresenceBanner(users || []); });

function renderPresenceBanner(users) {
  const others = users.filter((u) => u.username !== myUsername);
  if (others.length === 0) { presenceBanner.innerHTML = ''; return; }
  const cards = others.map((u) => {
    if (!u.online) {
      return `<div class="presence-card">
        <div><span class="dot offline"></span>${escapeHtml(u.username)} 当前不在线</div>
      </div>`;
    }

    if (u.location) {
      if (u.location.videoId === '__lobby_chat__') {
        return `<div class="presence-card">
          <div><span class="dot online"></span>${escapeHtml(u.username)} 正在聊天中</div>
          <button class="join-btn" data-id="__lobby_chat__" data-name="聊天室">加入聊天</button>
        </div>`;
      }
      const name = escapeHtml(u.location.videoName || '某个视频');
      return `<div class="presence-card">
        <div><span class="dot online"></span>${escapeHtml(u.username)} 正在观看《${name}》</div>
        <button class="join-btn" data-id="${escapeAttr(u.location.videoId)}" data-name="${escapeAttr(u.location.videoName || '')}">加入TA观看</button>
      </div>`;
    }

    return `<div class="presence-card">
      <div><span class="dot idle"></span>${escapeHtml(u.username)} 正在浏览视频列表</div>
    </div>`;
  });
  presenceBanner.innerHTML = cards.join('');
  presenceBanner.querySelectorAll('.join-btn').forEach((btn) => {
    btn.addEventListener('click', () => goToPlayer(btn.dataset.id, btn.dataset.name));
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

loadMe();
browseDir(''); // 从根目录开始