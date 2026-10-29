const meText = document.getElementById('meText');
const usersTbody = document.getElementById('usersTbody');
const listError = document.getElementById('listError');
const siteNameInput = document.getElementById('siteNameInput');
const siteNameError = document.getElementById('siteNameError');
const siteNameSuccess = document.getElementById('siteNameSuccess');

let myUsername = '';
let editPendingAvatar = null;

async function ensureAdmin() {
  const res = await fetch('/api/me');
  if (!res.ok) {
    window.location.href = '/login.html';
    return null;
  }
  const data = await res.json();
  if (data.role !== 'admin') {
    window.location.href = '/index.html';
    return null;
  }
  myUsername = data.username;
  meText.textContent = data.displayName || data.username;
  return data;
}

async function loadSiteName() {
  const res = await fetch('/api/admin/site-name');
  if (!res.ok) return;
  const data = await res.json();
  siteNameInput.value = data.siteName || '';
}

document.getElementById('saveSiteNameBtn').addEventListener('click', async () => {
  siteNameError.textContent = '';
  siteNameSuccess.textContent = '';
  try {
    const res = await fetch('/api/admin/site-name', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteName: siteNameInput.value.trim() }),
    });
    const data = await res.json();
    if (!res.ok) {
      siteNameError.textContent = data.error || '保存失败';
      return;
    }
    siteNameSuccess.textContent = '站点名称已更新';
    // 刷新页面标题
    if (window.__applySiteName) window.__applySiteName();
    else location.reload();
  } catch {
    siteNameError.textContent = '网络错误';
  }
});

function roleLabel(role) {
  return role === 'admin' ? '管理员' : '普通用户';
}

async function loadUsers() {
  listError.textContent = '';
  try {
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (!res.ok) {
      listError.textContent = data.error || '加载失败';
      return;
    }
    usersTbody.innerHTML = '';
    (data.users || []).forEach((u) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.displayName || u.username)}</td>
        <td>${roleLabel(u.role)}</td>
        <td><img class="avatar-thumb" src="${escapeAttr(u.avatar || '/avatar/default.png')}" alt=""></td>
        <td class="ops">
          <button type="button" class="btn-link" data-edit="${escapeAttr(u.username)}">编辑</button>
          <button type="button" class="btn-link danger" data-del="${escapeAttr(u.username)}">删除</button>
        </td>`;
      usersTbody.appendChild(tr);
    });
  } catch {
    listError.textContent = '网络错误';
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

usersTbody.addEventListener('click', async (e) => {
  const editBtn = e.target.closest('[data-edit]');
  const delBtn = e.target.closest('[data-del]');
  if (editBtn) {
    openEdit(editBtn.getAttribute('data-edit'));
    return;
  }
  if (delBtn) {
    const username = delBtn.getAttribute('data-del');
    if (username === myUsername) {
      alert('不能删除当前登录账号');
      return;
    }
    if (!confirm(`确定删除用户「${username}」？`)) return;
    const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || '删除失败');
      return;
    }
    loadUsers();
  }
});

document.getElementById('createUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const createError = document.getElementById('createError');
  const createSuccess = document.getElementById('createSuccess');
  createError.textContent = '';
  createSuccess.textContent = '';
  const username = document.getElementById('newUsername').value.trim();
  const displayName = document.getElementById('newDisplayName').value.trim() || username;
  const password = document.getElementById('newPassword').value;
  const role = document.getElementById('newRole').value;
  try {
    const res = await fetch('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, displayName, password, role }),
    });
    const data = await res.json();
    if (!res.ok) {
      createError.textContent = data.error || '创建失败';
      return;
    }
    createSuccess.textContent = `已创建用户 ${username}`;
    e.target.reset();
    loadUsers();
  } catch {
    createError.textContent = '网络错误';
  }
});

const editModal = document.getElementById('editModal');
const editError = document.getElementById('editError');

async function openEdit(username) {
  editError.textContent = '';
  editPendingAvatar = null;
  const res = await fetch('/api/admin/users');
  const data = await res.json();
  const u = (data.users || []).find((x) => x.username === username);
  if (!u) return;
  document.getElementById('editUsername').value = u.username;
  document.getElementById('editUsernameShow').value = u.username;
  document.getElementById('editDisplayName').value = u.displayName || u.username;
  document.getElementById('editRole').value = u.role === 'admin' ? 'admin' : 'user';
  document.getElementById('editPassword').value = '';
  document.getElementById('editAvatarPreview').src = u.avatar || '/avatar/default.png';
  editModal.hidden = false;
}

document.getElementById('editCancelBtn').addEventListener('click', () => {
  editModal.hidden = true;
});

document.getElementById('editAvatarPickBtn').addEventListener('click', () => {
  document.getElementById('editAvatarFile').click();
});

document.getElementById('editAvatarFile').addEventListener('change', async () => {
  const file = document.getElementById('editAvatarFile').files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('avatar', file);
  const res = await fetch('/api/avatar-upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) {
    editError.textContent = data.error || '上传失败';
    return;
  }
  editPendingAvatar = data.avatar;
  document.getElementById('editAvatarPreview').src = data.avatar;
});

document.getElementById('editUserForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  editError.textContent = '';
  const username = document.getElementById('editUsername').value;
  const body = {
    displayName: document.getElementById('editDisplayName').value.trim(),
    role: document.getElementById('editRole').value,
  };
  const pwd = document.getElementById('editPassword').value;
  if (pwd) body.password = pwd;
  if (editPendingAvatar) body.avatar = editPendingAvatar;

  const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    editError.textContent = data.error || '保存失败';
    return;
  }
  editModal.hidden = true;
  loadUsers();
});

(async () => {
  const me = await ensureAdmin();
  if (!me) return;
  await loadSiteName();
  await loadUsers();
})();


// ---- 日志清理 / 数据库维护 ----
document.getElementById('purgeLogsBtn').addEventListener('click', async () => {
  const purgeError = document.getElementById('purgeError');
  const purgeSuccess = document.getElementById('purgeSuccess');
  purgeError.textContent = '';
  purgeSuccess.textContent = '';
  const days = parseInt(document.getElementById('purgeDaysSelect').value, 10);
  const msg = days > 0 ? `确定删除 ${days} 天前的审计日志？` : '确定清空全部审计日志？此操作不可恢复。';
  if (!confirm(msg)) return;
  try {
    const res = await fetch('/api/admin/audit-logs/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    const data = await res.json();
    if (!res.ok) {
      purgeError.textContent = data.error || '清理失败';
      return;
    }
    purgeSuccess.textContent = `已删除 ${data.deleted} 条日志`;
  } catch {
    purgeError.textContent = '网络错误';
  }
});

document.getElementById('checkpointBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('dbMaintError');
  const okEl = document.getElementById('dbMaintSuccess');
  errEl.textContent = '';
  okEl.textContent = '';
  try {
    const res = await fetch('/api/admin/db/checkpoint', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || '操作失败';
      return;
    }
    okEl.textContent = '已将 WAL 合并写入主文件';
  } catch {
    errEl.textContent = '网络错误';
  }
});

document.getElementById('backupDbBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('dbMaintError');
  const okEl = document.getElementById('dbMaintSuccess');
  errEl.textContent = '';
  okEl.textContent = '';
  try {
    const res = await fetch('/api/admin/db/backup', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || '备份失败';
      return;
    }
    okEl.textContent = `备份成功：${data.file || data.path}`;
  } catch {
    errEl.textContent = '网络错误';
  }
});
