// 独立聊天室使用固定房间 ID，服务端复用现有 join-room 机制，无需任何服务端改动
const CHAT_ROOM_ID = '__lobby_chat__';

const sendBtn = document.getElementById('sendBtn');
const meText = document.getElementById('meText');
const presenceText = document.getElementById('presenceText');

let myUsername = '';
let socket = null;

// 把这个页面的 roomId 和"怎么拿到当前 socket"告诉共享的聊天逻辑（chatShared.js），
// 图片/语音发送时会用到。这里立刻调用、不等 socket 真正连上——getSocket 是一个
// "要发消息的时候再去问一下当前 socket 是什么"的函数，不是直接传 socket 本身，
// 因为这个页面的 socket 是异步建立的（下面 initSocket() 要等 loadMe() 拿到用户名
// 之后才会调用），用闭包引用 socket 这个 let 变量，之后不管它什么时候被真正赋值，
// chatShared.js 里调用 getSocket() 时都能拿到当下最新的值。
initChatShared({ roomId: CHAT_ROOM_ID, getSocket: () => socket });

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
    socket.emit('join-room', { videoId: CHAT_ROOM_ID }); // 服务端会用 videoId 反查/固定房间名，不再需要客户端传 videoName（和 player.js 保持一致）
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
    const fresh = filterNewHistoryMessages(messages);
    if (fresh.length === 0) return;
    fresh.forEach((msg) => appendChatMessage(msg, msg.from === myUsername));
    appendHistoryDivider();
    chatMessages.scrollTop = chatMessages.scrollHeight;
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
// 中文/日文/韩文输入法选字确认时按的 Enter 不算发送，见 isSendEnterKey() 的注释
chatInput.addEventListener('keydown', (e) => {
  if (isSendEnterKey(e)) { e.preventDefault(); sendChat(); }
});
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
});

loadMe();
