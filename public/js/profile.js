const meText = document.getElementById('meText');
const form = document.getElementById('profileForm');
const errorMsg = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');
const avatarPreview = document.getElementById('avatarPreview');
const avatarFile = document.getElementById('avatarFile');
const avatarPickBtn = document.getElementById('avatarPickBtn');

let currentAvatar = '/avatar/default.png';
let pendingAvatarUrl = null;

async function loadMe() {
  const res = await fetch('/api/me');
  if (!res.ok) {
    window.location.href = '/login.html';
    return;
  }
  const data = await res.json();
  meText.textContent = data.displayName || data.username;
  document.getElementById('username').value = data.username;
  document.getElementById('displayName').value = data.displayName || data.username;
  currentAvatar = data.avatar || '/avatar/default.png';
  avatarPreview.src = currentAvatar;
}

avatarPickBtn.addEventListener('click', () => avatarFile.click());

avatarFile.addEventListener('change', async () => {
  const file = avatarFile.files && avatarFile.files[0];
  if (!file) return;
  errorMsg.textContent = '';
  successMsg.textContent = '';
  const fd = new FormData();
  fd.append('avatar', file);
  try {
    const res = await fetch('/api/avatar-upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) {
      errorMsg.textContent = data.error || '上传失败';
      return;
    }
    pendingAvatarUrl = data.avatar;
    avatarPreview.src = data.avatar;
    successMsg.textContent = '头像已上传，请点击保存生效';
  } catch {
    errorMsg.textContent = '网络错误';
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.textContent = '';
  successMsg.textContent = '';

  const displayName = document.getElementById('displayName').value.trim();
  const currentPassword = document.getElementById('currentPassword').value;
  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (newPassword || confirmPassword) {
    if (newPassword !== confirmPassword) {
      errorMsg.textContent = '两次输入的新密码不一致';
      return;
    }
    if (!currentPassword) {
      errorMsg.textContent = '修改密码需要填写当前密码';
      return;
    }
  }

  const body = { displayName };
  if (pendingAvatarUrl) body.avatar = pendingAvatarUrl;
  if (newPassword) {
    body.password = newPassword;
    body.currentPassword = currentPassword;
  }

  try {
    const res = await fetch('/api/me', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      errorMsg.textContent = data.error || '保存失败';
      return;
    }
    pendingAvatarUrl = null;
    currentAvatar = data.user.avatar;
    avatarPreview.src = currentAvatar;
    meText.textContent = data.user.displayName;
    document.getElementById('currentPassword').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    successMsg.textContent = '已保存';
  } catch {
    errorMsg.textContent = '网络错误';
  }
});

loadMe().catch(() => { window.location.href = '/login.html'; });
