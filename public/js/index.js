const contentEl = document.getElementById('content');
const meText = document.getElementById('meText');
const logoutBtn = document.getElementById('logoutBtn');
const presenceBanner = document.getElementById('presenceBanner');
const breadcrumbEl = document.getElementById('breadcrumb');
const brandLogo = document.getElementById('brandLogo');

brandLogo.addEventListener('error', () => { brandLogo.style.display = 'none'; });

let myUsername = '';
let currentDir = ''; // 当前目录，'' = 根目录

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
  try {
    const qs = dir ? '?dir=' + encodeURIComponent(dir) : '';
    const res = await fetch('/api/browse' + qs);
    if (res.status === 401) { window.location.href = '/login.html'; return; }
    const data = await res.json();
    renderDirContents(data.dirs || [], data.videos || []);
  } catch {
    contentEl.innerHTML = '<div class="empty-state">加载目录失败，请刷新重试</div>';
  }
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