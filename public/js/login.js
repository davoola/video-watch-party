const form = document.getElementById('loginForm');
const errorMsg = document.getElementById('errorMsg');
const brandLogo = document.getElementById('brandLogo');

// logo.png 不存在或加载失败时直接隐藏这个图片位置，不影响登录功能。
// 用 addEventListener 而不是内联 onerror 属性，因为内联事件处理器
// 会被 Content-Security-Policy 的 script-src 'self' 拦截。
brandLogo.addEventListener('error', () => {
  brandLogo.style.display = 'none';
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorMsg.textContent = '';

  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (res.ok) {
      window.location.href = '/index.html';
    } else {
      errorMsg.textContent = data.error || '登录失败';
    }
  } catch (err) {
    errorMsg.textContent = '网络错误，请重试';
  }
});
