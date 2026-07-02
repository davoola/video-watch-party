// 独立聊天室使用固定房间 ID，服务端复用现有 join-room 机制，无需任何服务端改动
const CHAT_ROOM_ID = '__lobby_chat__';

const chatMessages = document.getElementById('chatMessages');
const chatInput   = document.getElementById('chatInput');
const sendBtn     = document.getElementById('sendBtn');
const meText      = document.getElementById('meText');
const presenceText = document.getElementById('presenceText');
const emojiBtn    = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');
const imageBtn    = document.getElementById('imageBtn');
const imageInput  = document.getElementById('imageInput');

let myUsername = '';
let socket = null;

// ---- 获取当前用户名（先拿到用户名再连 socket，确保 isSelf 判断正确）----
async function loadMe() {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) { window.location.href = '/login.html'; return; }
    const data = await res.json();
    myUsername = data.username;
    meText.textContent = `你好，${myUsername}`;
    initSocket();
  } catch {
    window.location.href = '/login.html';
  }
}

// ---- Socket 初始化 ----
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    socket.emit('join-room', { videoId: CHAT_ROOM_ID, videoName: '聊天室' });
  });

  socket.on('connect_error', (err) => {
    if (err.message === 'unauthorized') window.location.href = '/login.html';
  });

  socket.on('room-presence', ({ members }) => {
    const others = members.filter((m) => m !== myUsername);
    presenceText.textContent = others.length > 0
      ? `${others.join('、')} 在线`
      : '等待对方加入...';
  });

  socket.on('chat-history', ({ messages }) => {
    messages.forEach((msg) => appendChatMessage(msg, msg.from === myUsername));
    appendHistoryDivider();
  });

  socket.on('chat-system', ({ text }) => appendSystemMessage(text));

  socket.on('chat-message', (data) => {
    appendChatMessage(data, data.from === myUsername);
  });
}

// ---- 发送文字消息 ----
function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', { videoId: CHAT_ROOM_ID, type: 'text', text });
  chatInput.value = '';
  chatInput.style.height = '';
}

sendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
});

// ---- 表情选择器 ----
const EMOJI_LIST = [
  '😀','😂','🤣','😊','😍','🥰','😘','😜','🤔','😏',
  '😅','😭','😡','🥺','😱','🤯','🥳','😴','🤤','🙄',
  '👍','👎','👏','🙏','💪','❤️','💔','🔥','✨','🎉',
  '😎','🤗','🫡','😬','🤩','😇','👀','💯','🍿','☕',
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
      chatInput.dispatchEvent(new Event('input'));
	  emojiPicker.hidden = true; 
    });
    emojiPicker.appendChild(btn);
  });
  emojiPickerBuilt = true;
}
emojiBtn.addEventListener('click', () => {
  buildEmojiPicker();
  emojiPicker.hidden = !emojiPicker.hidden;
});
document.addEventListener('click', (e) => {
  if (!emojiPicker.hidden && !emojiBtn.contains(e.target) && !emojiPicker.contains(e.target)) {
    emojiPicker.hidden = true;
  }
});

// ---- 图片发送 ----
imageBtn.addEventListener('click', () => imageInput.click());
imageInput.addEventListener('change', async () => {
  const file = imageInput.files[0];
  imageInput.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { appendSystemMessage('图片不能超过 5MB'); return; }
  const formData = new FormData();
  formData.append('image', file);
  appendSystemMessage('正在发送图片...');
  try {
    const res = await fetch('/api/chat-upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) { appendSystemMessage(data.error || '图片发送失败'); return; }
    socket.emit('chat-message', { videoId: CHAT_ROOM_ID, type: 'image', imageUrl: data.url });
  } catch {
    appendSystemMessage('图片发送失败，请检查网络');
  }
});


// 生成头像元素：有头像 URL 就显示图片，否则显示名字首字符圆圈
function makeAvatar(name, avatarUrl) {
  if (avatarUrl) {
    const img = document.createElement('img');
    img.className = 'avatar';
    img.src = avatarUrl;
    img.alt = name;
    img.addEventListener('error', () => img.replaceWith(makeAvatar(name, null)));
    return img;
  }
  const el = document.createElement('div');
  el.className = 'avatar-initial';
  el.textContent = (name || '?').charAt(0).toUpperCase();
  return el;
}

// ---- 消息渲染 ----
function appendChatMessage(data, isSelf) {
  const div = document.createElement('div');
  div.className = 'msg' + (isSelf ? ' self' : '');

  // 头像 + 用户名行
  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const avatarEl = makeAvatar(data.from, data.avatar || null);
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = data.from;

  // 自己：名字在左、头像在右（由 CSS flex-direction:row-reverse 控制）
  meta.appendChild(avatarEl);
  meta.appendChild(who);
  div.appendChild(meta);

  // 消息气泡
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

function appendHistoryDivider() {
  const div = document.createElement('div');
  div.className = 'history-divider';
  div.textContent = '以上是历史消息';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

loadMe();