const params = new URLSearchParams(window.location.search);
const videoId = params.get('id');
const videoName = params.get('name') || '未知视频';

if (!videoId) {
  window.location.href = '/index.html';
}

const videoEl = document.getElementById('player');
const danmakuOverlay = document.getElementById('danmakuOverlay');
const danmakuToggle = document.getElementById('danmakuToggle');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const meText = document.getElementById('meText');
const presenceText = document.getElementById('presenceText');
const videoNameText = document.getElementById('videoNameText');
const chatPanel = document.getElementById('chatPanel');
const chatToggleBar = document.getElementById('chatToggleBar');
const unreadBadge = document.getElementById('unreadBadge');
const emojiBtn = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');
const imageBtn = document.getElementById('imageBtn');
const imageInput = document.getElementById('imageInput');

videoNameText.textContent = videoName;
videoEl.src = `/video-stream/${encodeURIComponent(videoId)}`;

let myUsername = '';
let isRemoteAction = false; // true 时表示当前事件是远程指令触发的，不要再广播出去
const SYNC_TOLERANCE = 0.6; // 秒，时间差在此范围内不强制跳转，避免抖动
const HEARTBEAT_INTERVAL = 5000; // 每 5 秒主动同步一次进度，纠正漂移

// ---- 当前用户名 ----
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

// ==================== Socket 连接 ====================
const socket = io();

socket.on('connect', () => {
  socket.emit('join-room', { videoId, videoName });
});

socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') window.location.href = '/login.html';
});

socket.on('room-presence', ({ members }) => {
  const others = members.filter((m) => m !== myUsername);
  presenceText.textContent = others.length > 0 ? `${others.join(', ')} 也在房间里` : '等待对方加入...';
});

socket.on('chat-system', ({ text }) => appendSystemMessage(text));

socket.on('chat-message', (data) => {
  const isSelf = data.from === myUsername;
  appendChatMessage(data, isSelf);
  if (!isSelf && data.type === 'text') {
    spawnDanmaku(data.text); // 图片消息不做弹幕，避免画面被加载中的图片干扰
  }
  if (chatPanel.classList.contains('collapsed') && !isSelf) {
    incrementUnread();
  }
});

// ==================== 播放同步 ====================
socket.on('video-action', ({ action, time }) => {
  isRemoteAction = true;

  const diff = Math.abs(videoEl.currentTime - time);
  if (diff > SYNC_TOLERANCE) videoEl.currentTime = time;

  if (action === 'play') {
    videoEl.play().catch(() => {
      appendSystemMessage('浏览器阻止了自动播放，请手动点击播放按钮以同步');
    });
  } else if (action === 'pause') {
    videoEl.pause();
  }

  setTimeout(() => { isRemoteAction = false; }, 200);
});

videoEl.addEventListener('play', () => {
  if (isRemoteAction) return;
  socket.emit('video-action', { videoId, action: 'play', time: videoEl.currentTime });
});

videoEl.addEventListener('pause', () => {
  if (isRemoteAction) return;
  socket.emit('video-action', { videoId, action: 'pause', time: videoEl.currentTime });
});

videoEl.addEventListener('seeked', () => {
  if (isRemoteAction) return;
  socket.emit('video-action', { videoId, action: 'seek', time: videoEl.currentTime });
});

setInterval(() => {
  if (videoEl.paused || videoEl.seeking) return;
  socket.emit('video-action', { videoId, action: 'heartbeat', time: videoEl.currentTime });
}, HEARTBEAT_INTERVAL);

// ==================== 聊天发送（文本） ====================
// 发送消息的同时，如果开启了弹幕，自己发的消息也飞一条，体验和收到对方消息一致
const TEXTAREA_MIN_HEIGHT = 56;
const TEXTAREA_MAX_HEIGHT = 160;

function resetTextareaHeight() {
  chatInput.style.height = TEXTAREA_MIN_HEIGHT + 'px';
}

function autoResizeTextarea() {
  chatInput.style.height = 'auto';
  const next = Math.min(chatInput.scrollHeight, TEXTAREA_MAX_HEIGHT);
  chatInput.style.height = Math.max(next, TEXTAREA_MIN_HEIGHT) + 'px';
}

function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat-message', { videoId, type: 'text', text });
  spawnDanmaku(text);
  chatInput.value = '';
  resetTextareaHeight();
}

sendBtn.addEventListener('click', sendChat);

chatInput.addEventListener('input', autoResizeTextarea);

// Enter 发送消息；Shift+Enter 换行（不发送，走 textarea 默认行为插入换行符）
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// ==================== 消息渲染 ====================
function appendChatMessage(data, isSelf) {
  const div = document.createElement('div');
  div.className = 'msg' + (isSelf ? ' self' : '');

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = data.from;
  div.appendChild(who);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (data.type === 'image') {
    bubble.classList.add('image-bubble');
    const img = document.createElement('img');
    img.className = 'chat-image';
    img.src = data.imageUrl;
    img.alt = '图片消息';
    img.addEventListener('click', () => window.open(data.imageUrl, '_blank'));
    bubble.appendChild(img);
  } else {
    // renderMarkdown 内部已做 HTML 转义 + 仅生成受控标签，可安全设置 innerHTML
    bubble.innerHTML = renderMarkdown(data.text);
  }

  div.appendChild(bubble);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ==================== 弹幕 ====================
const DANMAKU_LANES = 6; // 从 7 调整为 6，配合更大的字号，轨道之间留出更舒服的间距
let danmakuLaneCursor = 0;

// 每条弹幕从这个调色板里随机挑一个颜色，而不是固定"自己=某色，对方=某色"，
// 视觉上会更热闹，双方消息的颜色大概率也会不一样（但不强制保证一定不同）。
const DANMAKU_COLORS = [
  '#ff6b6b', // 珊瑚红
  '#ffa94d', // 橙
  '#ffd43b', // 黄
  '#69db7c', // 绿
  '#3bc9db', // 青
  '#4dabf7', // 蓝
  '#9775fa', // 紫
  '#f06595', // 粉
  '#63e6be', // 薄荷绿
  '#ff8787', // 浅红
];

function pickRandomDanmakuColor() {
  return DANMAKU_COLORS[Math.floor(Math.random() * DANMAKU_COLORS.length)];
}

function spawnDanmaku(rawText) {
  if (!danmakuToggle.checked) return;
  if (typeof rawText !== 'string' || !rawText.trim()) return;

  const item = document.createElement('div');
  item.className = 'danmaku-item';
  // 复用同一套安全渲染逻辑，弹幕里也能看到加粗/斜体等效果
  item.innerHTML = renderInlineMarkdown(rawText.slice(0, 100)); // 弹幕长度截断，避免超长文本影响观感
  item.style.color = pickRandomDanmakuColor();

  const overlayHeight = danmakuOverlay.clientHeight || 300;
  const laneHeight = overlayHeight / DANMAKU_LANES;
  const lane = danmakuLaneCursor % DANMAKU_LANES;
  danmakuLaneCursor++;

  item.style.top = `${lane * laneHeight + 4}px`;

  // 只在 PC 端放慢弹幕速度，移动端保持原速度（用户反馈移动端速度已经合适）。
  // 复用现有的响应式断点（860px），与 CSS 里判断"是否进入移动布局"的标准保持一致。
  const isMobileLayout = window.matchMedia('(max-width: 860px)').matches;
  const baseDuration = isMobileLayout ? 6 : 8;
  const duration = baseDuration + Math.min(rawText.length / 8, 6);
  item.style.animationDuration = `${duration}s`;

  danmakuOverlay.appendChild(item);
  item.addEventListener('animationend', () => item.remove());
}

danmakuToggle.addEventListener('change', () => {
  localStorage.setItem('vwp_danmaku_enabled', danmakuToggle.checked ? '1' : '0');
});

// 恢复上次的弹幕开关偏好
const savedDanmakuPref = localStorage.getItem('vwp_danmaku_enabled');
if (savedDanmakuPref !== null) {
  danmakuToggle.checked = savedDanmakuPref === '1';
}

// ==================== 表情选择器 ====================
const EMOJI_LIST = [
  '😀', '😂', '🤣', '😊', '😍', '🥰', '😘', '😜', '🤔', '😏',
  '😅', '😭', '😡', '🥺', '😱', '🤯', '🥳', '😴', '🤤', '🙄',
  '👍', '👎', '👏', '🙏', '💪', '❤️', '💔', '🔥', '✨', '🎉',
  '😎', '🤗', '🫡', '😬', '🤩', '😇', '👀', '💯', '🍿', '☕',
];

let emojiPickerBuilt = false;
function buildEmojiPicker() {
  if (emojiPickerBuilt) return;
  EMOJI_LIST.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = emoji;
    btn.addEventListener('click', () => {
      chatInput.value += emoji;
      chatInput.focus();
      autoResizeTextarea();
    });
    emojiPicker.appendChild(btn);
  });
  emojiPickerBuilt = true;
}

emojiBtn.addEventListener('click', () => {
  buildEmojiPicker();
  emojiPicker.hidden = !emojiPicker.hidden;
});

// ==================== 图片发送 ====================
imageBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', async () => {
  const file = imageInput.files[0];
  imageInput.value = '';
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    appendSystemMessage('图片不能超过 5MB');
    return;
  }

  const formData = new FormData();
  formData.append('image', file);

  appendSystemMessage('正在发送图片...');

  try {
    const res = await fetch('/api/chat-upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      appendSystemMessage(data.error || '图片发送失败');
      return;
    }

    socket.emit('chat-message', { videoId, type: 'image', imageUrl: data.url });
  } catch (err) {
    appendSystemMessage('图片发送失败，请检查网络');
  }
});

// ==================== 移动端聊天抽屉 ====================
chatToggleBar.addEventListener('click', () => {
  chatPanel.classList.toggle('collapsed');
  if (!chatPanel.classList.contains('collapsed')) {
    resetUnread();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
});

let unreadCount = 0;
function incrementUnread() {
  unreadCount++;
  unreadBadge.hidden = false;
  unreadBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
}
function resetUnread() {
  unreadCount = 0;
  unreadBadge.hidden = true;
}

// 默认在窄屏上把聊天面板折叠，留出更多空间看视频；桌面端这个 class 不会产生视觉影响
if (window.matchMedia('(max-width: 860px)').matches) {
  chatPanel.classList.add('collapsed');
}

loadMe();
