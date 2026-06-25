const contentEl = document.getElementById('content');
const meText = document.getElementById('meText');
const logoutBtn = document.getElementById('logoutBtn');
const presenceBanner = document.getElementById('presenceBanner');

let myUsername = '';

function formatSize(bytes) {
  if (!bytes) return '未知大小';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  return mb.toFixed(1) + ' MB';
}

async function loadMe() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) {
      window.location.href = '/login.html';
      return;
    }
    const data = await res.json();
    myUsername = data.username;
    meText.textContent = `你好，${myUsername}`;
  } catch {
    window.location.href = '/login.html';
  }
}

async function loadVideos() {
  try {
    const res = await fetch('/api/videos');
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    const data = await res.json();
    renderVideos(data.videos || []);
  } catch (err) {
    contentEl.innerHTML = '<div class="empty-state">加载视频列表失败，请刷新重试</div>';
  }
}

function renderVideos(videos) {
  if (videos.length === 0) {
    contentEl.innerHTML = '<div class="empty-state">视频目录里还没有找到视频文件</div>';
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'video-grid';

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
    img.addEventListener('error', () => {
      // 缩略图加载失败（没装 ffmpeg、生成失败、视频损坏等）：隐藏图片，露出下面的 ▶ 占位图标
      thumbEl.classList.add('thumb-fallback-active');
    });
    img.addEventListener('load', () => {
      thumbEl.classList.add('thumb-loaded');
    });
    card.addEventListener('click', () => goToPlayer(v.id, v.name));
    grid.appendChild(card);
  });

  contentEl.innerHTML = '';
  contentEl.appendChild(grid);
}

function goToPlayer(id, name) {
  window.location.href = `/player.html?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ---- 大厅在线状态：实时显示对方在哪个视频页面 ----
const socket = io();

socket.on('connect', () => {
  socket.emit('enter-lobby');
});

socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') window.location.href = '/login.html';
});

socket.on('lobby-presence', ({ users }) => {
  renderPresenceBanner(users || []);
});

function renderPresenceBanner(users) {
  const others = users.filter((u) => u.username !== myUsername);

  if (others.length === 0) {
    presenceBanner.innerHTML = '';
    return;
  }

  const cards = others.map((u) => {
    if (!u.online) {
      return `
        <div class="presence-card">
          <div><span class="dot offline"></span>${escapeHtml(u.username)} 当前不在线</div>
        </div>`;
    }
    if (u.location) {
      const name = escapeHtml(u.location.videoName || '某个视频');
      return `
        <div class="presence-card">
          <div><span class="dot online"></span>${escapeHtml(u.username)} 正在观看《${name}》</div>
          <button class="join-btn" data-id="${escapeAttr(u.location.videoId)}" data-name="${escapeAttr(u.location.videoName || '')}">加入TA观看</button>
        </div>`;
    }
    return `
      <div class="presence-card">
        <div><span class="dot idle"></span>${escapeHtml(u.username)} 正在浏览视频列表</div>
      </div>`;
  });

  presenceBanner.innerHTML = cards.join('');

  presenceBanner.querySelectorAll('.join-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      goToPlayer(btn.dataset.id, btn.dataset.name);
    });
  });
}

function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

loadMe();
loadVideos();
