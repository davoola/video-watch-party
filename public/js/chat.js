// 独立聊天室使用固定房间 ID，服务端复用现有 join-room 机制
const CHAT_ROOM_ID = '__lobby_chat__';

const sendBtn = document.getElementById('sendBtn');
const meText = document.getElementById('meText');
const presenceText = document.getElementById('presenceText');

let myUsername = '';
let socket = null;

// 向上翻历史：当前列表中最旧一条消息的时间戳；是否还有更早记录；是否正在请求中
let oldestHistoryTs = null;
let historyHasMore = false;
let historyLoading = false;

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

// 根据一批消息更新“最旧时间戳”
function updateOldestFromMessages(messages) {
  if (!messages || messages.length === 0) return;
  for (const msg of messages) {
    if (msg.ts && (oldestHistoryTs == null || msg.ts < oldestHistoryTs)) {
      oldestHistoryTs = msg.ts;
    }
  }
}

function requestOlderHistory() {
  if (!socket || historyLoading || !historyHasMore) return;
  if (oldestHistoryTs == null) return;
  historyLoading = true;
  showLoadMoreHint('加载中…');
  socket.emit('chat-load-more', { beforeTs: oldestHistoryTs });
}

function showLoadMoreHint(text) {
  let el = document.getElementById('chatLoadMoreHint');
  if (!text) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'chatLoadMoreHint';
    el.className = 'msg system';
    chatMessages.insertBefore(el, chatMessages.firstChild);
  }
  el.textContent = text;
}

// ---- Socket 初始化 ----
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    // 重连时重置分页状态：服务端会再发一轮最近历史，之后可继续向上翻
    oldestHistoryTs = null;
    historyHasMore = false;
    historyLoading = false;
    showLoadMoreHint(null);
    socket.emit('join-room', { videoId: CHAT_ROOM_ID });
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

  socket.on('chat-history', ({ messages, hasMore }) => {
    const fresh = filterNewHistoryMessages(messages);
    if (fresh.length === 0) {
      // 可能是重连且没有新消息，但服务端仍可能告知 hasMore
      if (typeof hasMore === 'boolean') historyHasMore = hasMore;
      return;
    }
    fresh.forEach((msg) => appendChatMessage(msg, msg.from === myUsername));
    appendHistoryDivider();
    updateOldestFromMessages(fresh);
    // 首次/重连批次：以服务端 hasMore 为准；若未带该字段，按“是否满页”猜测
    historyHasMore = typeof hasMore === 'boolean' ? hasMore : fresh.length >= 100;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });

  // 向上翻：更早的一批历史，插到顶部并保持当前阅读位置不跳动
  socket.on('chat-history-more', ({ messages, hasMore }) => {
    historyLoading = false;
    showLoadMoreHint(null);

    if (!messages || messages.length === 0) {
      historyHasMore = false;
      return;
    }

    const prevHeight = chatMessages.scrollHeight;
    const prevTop = chatMessages.scrollTop;

    prependChatMessages(messages, (msg) => msg.from === myUsername);
    updateOldestFromMessages(messages);
    historyHasMore = typeof hasMore === 'boolean' ? hasMore : messages.length >= 50;

    // 保持用户当前看到的内容不动：新内容加在上方后，滚动位置补偿高度差
    chatMessages.scrollTop = prevTop + (chatMessages.scrollHeight - prevHeight);
  });

  socket.on('chat-system', ({ text }) => appendSystemMessage(text));

  socket.on('chat-message', (data) => {
    appendChatMessage(data, data.from === myUsername);
  });
}

// 滚到顶部附近时请求更早历史（阈值节流，避免连续触发）
let scrollLoadTimer = null;
chatMessages.addEventListener('scroll', () => {
  if (scrollLoadTimer) return;
  scrollLoadTimer = setTimeout(() => {
    scrollLoadTimer = null;
    if (chatMessages.scrollTop <= 40) {
      requestOlderHistory();
    }
  }, 120);
});

// ---- 发送文字消息 ----
function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', { videoId: CHAT_ROOM_ID, type: 'text', text });
  chatInput.value = '';
  chatInput.style.height = '';
}

sendBtn.addEventListener('click', sendChat);
// 中文/日文/韩文输入法选字确认时的 Enter 不能触发发送，见 chatShared.js 里 isSendEnterKey 的说明
chatInput.addEventListener('keydown', (e) => {
  if (isSendEnterKey(e)) {
    e.preventDefault();
    sendChat();
  }
});

// 输入时自动增高（有上限）
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
});

loadMe();
