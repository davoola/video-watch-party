const params = new URLSearchParams(window.location.search);
const videoId = params.get('id');
const videoName = params.get('name') || '未知视频';

if (!videoId) {
  window.location.href = '/index.html';
}

const videoEl = document.getElementById('player');
const danmakuOverlay = document.getElementById('danmakuOverlay');
const danmakuToggle = document.getElementById('danmakuToggle');

// 恢复上次的弹幕开关偏好：HTML 里 <input id="danmakuToggle" checked> 默认是勾选状态，
// 如果这段"读 localStorage、按需改成未勾选"的逻辑放在文件末尾才执行，中间会有一帧
// "先渲染成默认勾选、再被 JS 改回未勾选"的闪烁（虽然很轻微，但确实存在）。
// 放在这里、拿到 DOM 引用后立刻执行，能在浏览器第一次绘制这个页面之前就把状态改对，
// 不需要等到整个脚本跑完。
const savedDanmakuPref = localStorage.getItem('vwp_danmaku_enabled');
if (savedDanmakuPref !== null) {
  danmakuToggle.checked = savedDanmakuPref === '1';
}

const sendBtn = document.getElementById('sendBtn');
const meText = document.getElementById('meText');
const presenceText = document.getElementById('presenceText');
const videoNameText = document.getElementById('videoNameText');
const chatPanel = document.getElementById('chatPanel');
const chatToggleBar = document.getElementById('chatToggleBar');
const unreadBadge = document.getElementById('unreadBadge');
const chatResizer = document.getElementById('chatResizer');

// 统一的响应式断点判断：matches === true 表示当前是移动布局。
// 和 CSS 里的 @media (max-width: 860px) 保持一致，全文件多处用到（弹幕速度、聊天面板宽度/折叠等）。
const mobileLayoutQuery = window.matchMedia('(max-width: 860px)');

videoNameText.textContent = videoName;
videoEl.src = `/video-stream/${encodeURIComponent(videoId)}`;

let myUsername = '';
// 远端指令触发本地播放器变化时，本地的 play/pause/seeked 监听器不应该把这次变化
// 当成"用户自己操作的"再广播回去，否则会来回"回声"。
// 之前用一个简单的布尔值 + 固定 200ms 超时来做这件事，但 videoEl.play() 是异步的，
// seeked 事件也是异步的，在设备/网络较慢时，这些事件可能在 200ms 之后才触发——
// 此时标记已经被提前重置成了 false，导致远端来的变化被误判成本地操作，又广播回去，
// 造成短暂的"你纠正我、我又纠正你"式抖动。
// 改成一个计数器：处理远端指令时，先算好"接下来会有几个本地事件是这次指令必然导致的"
// （比如同时要 seek 又要切换播放/暂停状态，就是 2 个），登记这个数量；
// 每次 play/pause/seeked 事件触发时，如果还有"待认领"的名额，就消耗掉一个、不广播，
// 没有名额了才说明是用户自己的操作，正常广播。1500ms 兜底超时防止极端情况下
// （比如 play() 被静默拒绝导致 play 事件永远不会来）计数器卡住不清零。
let remoteActionPending = 0;
let remoteActionTimeout = null;

function expectRemoteEvents(count) {
  remoteActionPending += count;
  clearTimeout(remoteActionTimeout);
  remoteActionTimeout = setTimeout(() => { remoteActionPending = 0; }, 1500);
}

function consumeRemoteEvent() {
  if (remoteActionPending > 0) {
    remoteActionPending -= 1;
    return true; // 这个事件是远端指令导致的，本地不应该再广播出去
  }
  return false;
}

let hasOthersInRoom = false; // 房间里是否还有除自己以外的人在——没人时心跳没有意义，可以省掉

// 同步容忍度按事件类型区分：
// - play/pause/seek 是用户主动操作，希望对方尽快精确跟随，容忍度小一点
// - heartbeat 只是周期性纠偏（双方都在定时互相广播当前进度），如果用两个一样紧的容忍度，
//   网络延迟不对称时容易出现"你纠正我、我又纠正你"的来回拉扯式抖动，所以心跳给更宽松的容忍度
const SYNC_TOLERANCE_ACTION = 0.6; // 秒
const SYNC_TOLERANCE_HEARTBEAT = 2.0; // 秒
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

// 把这个页面的 roomId（视频房间的 videoId）和"怎么拿到当前 socket"告诉共享的聊天逻辑
// （chatShared.js），图片/语音发送时会用到。播放页的 socket 是上面这行同步创建的、
// 不会是 null，所以 chatShared.js 里对应的 null 检查在这个页面永远不会触发，
// 纯粹是为了和独立聊天室页面共用同一份逻辑。
initChatShared({ roomId: videoId, getSocket: () => socket });

socket.on('connect', () => {
  socket.emit('join-room', { videoId });
});

socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') window.location.href = '/login.html';
});

socket.on('room-presence', ({ members }) => {
  const others = members.filter((m) => m !== myUsername);
  hasOthersInRoom = others.length > 0;
  presenceText.textContent = others.length > 0 ? `${others.join(', ')} 也在房间里` : '等待对方加入...';
});

socket.on('chat-system', ({ text }) => appendSystemMessage(text));

// 刚加入房间时，服务端会把这个房间最近的聊天记录发过来（重新整理过的，按时间顺序）。
// 用一条分隔线把"历史消息"和"接下来的新消息"区分开，避免让人误以为是刚刚发生的对话。
socket.on('chat-history', ({ messages }) => {
  const fresh = filterNewHistoryMessages(messages);
  if (fresh.length === 0) return;
  fresh.forEach((msg) => {
    appendChatMessage(msg, msg.from === myUsername);
  });
  appendHistoryDivider();
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

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

// 刚进页面（或者重连）时，视频的 metadata 可能还没加载完（readyState < 1 / HAVE_METADATA）。
// 这时候如果直接 videoEl.currentTime = time，不同浏览器的实际表现不完全一致——按规范
// 应该被记成"默认播放起始位置"、等 metadata 加载完后自动生效，但实践中确实观察到
// 部分浏览器/场景下这次赋值会被直接忽略，导致"刚进页面/断线重连"时的这一次同步偶发
// 失效（后续的心跳最终还是会纠正，但要多等最多 5 秒）。这里显式处理：metadata 还没
// 好的话就先记下来，等 loadedmetadata 事件真正触发后再补上。
let pendingSeekTime = null;

function applySeekTime(time) {
  if (videoEl.readyState >= 1) { // HAVE_METADATA 及以上，duration/可寻址范围已经确定
    videoEl.currentTime = time;
  } else {
    pendingSeekTime = time;
  }
}

videoEl.addEventListener('loadedmetadata', () => {
  if (pendingSeekTime !== null) {
    videoEl.currentTime = pendingSeekTime;
    pendingSeekTime = null;
  }
});

socket.on('video-action', ({ action, time }) => {
  const tolerance = action === 'heartbeat' ? SYNC_TOLERANCE_HEARTBEAT : SYNC_TOLERANCE_ACTION;
  const diff = Math.abs(videoEl.currentTime - time);
  const willSeek = diff > tolerance;
  const willPlay = action === 'play' && videoEl.paused;
  const willPause = action === 'pause' && !videoEl.paused;

  // 只登记"这次指令实际会导致发生"的本地事件数量——如果心跳时进度差在容忍范围内、
  // 且播放/暂停状态本来就一致，这次远端指令不会让播放器发生任何变化，也就不需要
  // 等待任何事件来"认领"，避免计数器卡在大于 0 的状态、误伤后续真正的本地操作。
  const expectedCount = (willSeek ? 1 : 0) + (willPlay || willPause ? 1 : 0);
  if (expectedCount > 0) expectRemoteEvents(expectedCount);

  if (willSeek) applySeekTime(time);

  if (action === 'play') {
    videoEl.play().catch(() => {
      appendSystemMessage('浏览器阻止了自动播放，请手动点击播放按钮以同步');
      // play() 被拒绝就不会有 play 事件触发来"认领"这个名额，手动扣掉，避免计数器卡住
      if (willPlay) remoteActionPending = Math.max(0, remoteActionPending - 1);
    });
  } else if (action === 'pause') {
    videoEl.pause();
  }
});

videoEl.addEventListener('play', () => {
  if (consumeRemoteEvent()) return;
  socket.emit('video-action', { videoId, action: 'play', time: videoEl.currentTime });
});

videoEl.addEventListener('pause', () => {
  if (consumeRemoteEvent()) return;
  socket.emit('video-action', { videoId, action: 'pause', time: videoEl.currentTime });
});

videoEl.addEventListener('seeked', () => {
  if (consumeRemoteEvent()) return;
  socket.emit('video-action', { videoId, action: 'seek', time: videoEl.currentTime });
});

setInterval(() => {
  if (videoEl.paused || videoEl.seeking) return;
  if (!hasOthersInRoom) return; // 房间里没有其他人时，心跳没有"纠正对方漂移"的意义，省掉这次心跳
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

// Enter 发送消息；Shift+Enter 换行（不发送，走 textarea 默认行为插入换行符）；
// 中文/日文/韩文输入法选字确认时按的 Enter 不算发送，见 isSendEnterKey() 的注释
chatInput.addEventListener('keydown', (e) => {
  if (isSendEnterKey(e)) {
    e.preventDefault();
    sendChat();
  }
});

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
  const baseDuration = mobileLayoutQuery.matches ? 6 : 8;
  const duration = baseDuration + Math.min(rawText.length / 8, 6);
  item.style.animationDuration = `${duration}s`;

  danmakuOverlay.appendChild(item);
  item.addEventListener('animationend', () => item.remove());
}

danmakuToggle.addEventListener('change', () => {
  localStorage.setItem('vwp_danmaku_enabled', danmakuToggle.checked ? '1' : '0');
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
if (mobileLayoutQuery.matches) {
  chatPanel.classList.add('collapsed');
}

// ==================== 聊天面板宽度拖拽调整（仅桌面布局） ====================
const CHAT_WIDTH_STORAGE_KEY = 'vwp_chat_width';
const CHAT_WIDTH_MIN = 240;
const CHAT_WIDTH_DEFAULT = 320;

function getChatWidthMax() {
  // 最大不超过窗口宽度的 60%，且不超过 640px，避免把视频区挤得太小
  return Math.min(640, window.innerWidth * 0.6);
}

function setChatWidth(px) {
  const clamped = Math.max(CHAT_WIDTH_MIN, Math.min(px, getChatWidthMax()));
  chatPanel.style.width = clamped + 'px';
  return clamped;
}

// 根据当前是桌面布局还是移动布局，决定要不要应用拖拽宽度：
// 移动端布局靠 CSS 的 width:100% 规则铺满宽度，这里必须清掉内联 style.width，
// 否则内联样式的优先级比 CSS 规则高，会让移动端布局错乱（聊天面板宽度不对）。
function applyChatWidthForViewport() {
  if (mobileLayoutQuery.matches) {
    chatPanel.style.width = '';
    return;
  }
  const saved = parseFloat(localStorage.getItem(CHAT_WIDTH_STORAGE_KEY));
  setChatWidth(Number.isFinite(saved) ? saved : CHAT_WIDTH_DEFAULT);
}

applyChatWidthForViewport();
// 监听断点切换：比如把浏览器窗口从桌面宽度拖小到移动宽度（不刷新页面也要正确响应）
mobileLayoutQuery.addEventListener('change', applyChatWidthForViewport);

let isDraggingChat = false;

chatResizer.addEventListener('mousedown', (e) => {
  if (mobileLayoutQuery.matches) return; // 移动布局下手柄本身也被 CSS 隐藏了，这里是双重保险
  isDraggingChat = true;
  chatResizer.classList.add('is-dragging');
  document.body.classList.add('is-resizing-chat');
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!isDraggingChat) return;
  // 聊天面板在右侧，宽度 = 视口宽度 - 鼠标的水平坐标
  const newWidth = setChatWidth(window.innerWidth - e.clientX);
  localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(newWidth));
});

window.addEventListener('mouseup', stopDraggingChat);

function stopDraggingChat() {
  if (!isDraggingChat) return;
  isDraggingChat = false;
  chatResizer.classList.remove('is-dragging');
  document.body.classList.remove('is-resizing-chat');
}

// 双击手柄恢复默认宽度，方便一键复位
chatResizer.addEventListener('dblclick', () => {
  if (mobileLayoutQuery.matches) return;
  setChatWidth(CHAT_WIDTH_DEFAULT);
  localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(CHAT_WIDTH_DEFAULT));
});

// 触屏支持（比如宽屏触屏笔记本/平板横屏时仍处于桌面布局）
chatResizer.addEventListener('touchstart', (e) => {
  if (mobileLayoutQuery.matches) return;
  isDraggingChat = true;
  chatResizer.classList.add('is-dragging');
  document.body.classList.add('is-resizing-chat');
}, { passive: true });

window.addEventListener('touchmove', (e) => {
  if (!isDraggingChat || !e.touches[0]) return;
  const newWidth = setChatWidth(window.innerWidth - e.touches[0].clientX);
  localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(newWidth));
}, { passive: true });

window.addEventListener('touchend', stopDraggingChat);

// 窗口本身被拉伸时，确保当前宽度依然落在合法范围内（比如窗口缩小导致原宽度超过了新的最大值上限）
window.addEventListener('resize', () => {
  if (mobileLayoutQuery.matches) return;
  const current = parseFloat(chatPanel.style.width);
  if (Number.isFinite(current)) setChatWidth(current);
});

loadMe();
