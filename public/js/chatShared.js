// ==================== 聊天公共逻辑（player.js 与 chat.js 共用） ====================
// 播放页内嵌的聊天面板和独立聊天室页面，除了各自的视频同步/弹幕/面板拖拽这些页面
// 专属逻辑之外，消息渲染、表情选择器、图片/语音发送这一整套聊天基础设施是完全一样的
// （字节级重复，约 250 行）。这个文件把这部分逻辑抽出来，两边共用同一份实现。
//
// 依赖：
// - HTML 里必须存在这些 id 相同的元素（player.html / chat.html 两边本来就有）：
//   chatMessages、chatInput、emojiBtn、emojiPicker、imageBtn、imageInput、
//   voiceBtn、voiceRecordingIndicator、voiceTimer、voiceCancelBtn
// - 必须在这个文件之前加载好 markdown.js（用到 renderMarkdown）和 lightbox.js（用到 Lightbox）
//
// 用法：页面自己的脚本里，在页面专属的初始化逻辑就绪后调用一次：
//   initChatShared({ roomId: 'xxx', getSocket: () => socket });
// - roomId：发送图片/语音消息时，socket 广播 payload 里的 videoId 字段用这个值
// - getSocket：一个"要发消息的时候再去问一下当前 socket 是什么"的函数，而不是直接
//   传 socket 本身——因为独立聊天室页面的 socket 是异步建立的（先拿用户名再连接），
//   调用 initChatShared() 的时候可能还没连上，用函数间接引用才能在真正发送的那一刻
//   拿到最新的 socket（可能仍然是 null，getSocket() 返回 null 时会提示"连接尚未建立"）。

const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const emojiBtn = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');
const imageBtn = document.getElementById('imageBtn');
const imageInput = document.getElementById('imageInput');
const voiceBtn = document.getElementById('voiceBtn');
const voiceRecordingIndicator = document.getElementById('voiceRecordingIndicator');
const voiceTimer = document.getElementById('voiceTimer');
const voiceCancelBtn = document.getElementById('voiceCancelBtn');

// 判断一次 keydown 的 Enter 是不是"该发送消息了"，而不是中文/日文/韩文输入法在选字过程
// 中确认候选词按下的 Enter。中文输入法打字时按 Enter 选词，浏览器同样会触发
// key === 'Enter' 的 keydown 事件——如果不加区分，选字过程中随手按的 Enter 会被当成
// "发送"，把还没打完的半句话/拼音直接发出去，这是中文用户几乎必然会踩到的坑。
// - e.isComposing 是标准做法，覆盖绝大多数现代浏览器；
// - e.keyCode === 229 是历史遗留的兜底：部分浏览器（尤其桌面版 Safari 的某些版本）
//   在输入法组合态下 isComposing 不完全可靠，但组合态期间产生的按键事件 keyCode
//   固定是 229，两个条件一起判断更稳妥。
function isSendEnterKey(e) {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
}

// initChatShared() 填入，发送图片/语音时用
let _chatRoomId = null;
let _getSocket = () => null;

function initChatShared(options) {
  _chatRoomId = options.roomId;
  _getSocket = options.getSocket;
}

// ==================== Markdown 代码块右上角的"复制"按钮 ====================
// CSP 里 script-src 'self' 不允许内联事件处理器，所以不能在 markdown.js 生成的 HTML
// 里直接写 onclick=...，只能在这里用事件委托，在 chatMessages 这个容器上监听点击、
// 判断点的是不是 .md-copy-btn。
async function copyCodeFromButton(button) {
  const wrap = button.closest('.md-code-block-wrap');
  const codeEl = wrap && wrap.querySelector('code');
  if (!codeEl) return;

  const text = codeEl.textContent;
  const originalLabel = button.textContent;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // Clipboard API 在非安全上下文（HTTP 而非 HTTPS/localhost）下不可用，
      // 退回到这个老办法：临时插入一个不可见的 textarea，选中后用 execCommand('copy')。
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    button.textContent = '已复制';
    button.classList.add('copied');
  } catch {
    button.textContent = '复制失败';
  }

  setTimeout(() => {
    button.textContent = originalLabel;
    button.classList.remove('copied');
  }, 1500);
}

chatMessages.addEventListener('click', (e) => {
  const btn = e.target.closest('.md-copy-btn');
  if (btn) copyCodeFromButton(btn);
});

// ==================== 头像 / 语音时长格式化 ====================
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

// 语音消息气泡里显示的时长文字，比如 65 秒显示成 "1:05"。
// 只是个展示用的提示（服务端已经把它夹取到 0～120 秒范围内），不是权威时长——
// 真正的播放进度以 <audio> 元素自己读取到的文件时长为准。
function formatVoiceDuration(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ==================== 聊天图片的 lightbox ====================
// 点开任意一张图，左右/上下键能翻遍"当前聊天记录里的所有图片"（不管是直接发送的
// 图片，还是 Markdown 语法 ![alt](url) 插入的行内图片），不是只能看那一张。
// 每次点击时都重新从 DOM 里查一遍当前所有图片，而不是维护一个额外的数组去同步，
// 这样即使消息列表被清空重建（比如切换视频房间），也不会有"数组和 DOM 对不上"的问题。
function openChatImageLightbox(clickedImg) {
  const allImages = Array.from(chatMessages.querySelectorAll('img.chat-image, img.md-image'));
  const items = allImages.map((img) => ({ url: img.src, caption: img.dataset.caption || '' }));
  const index = allImages.indexOf(clickedImg);
  Lightbox.open(items, index >= 0 ? index : 0);
}

// ==================== 消息渲染 ====================

// "目前为止渲染过的消息里最新的一条的时间戳"，appendChatMessage() 每次渲染消息时更新，
// filterNewHistoryMessages() 用它在断线重连时过滤掉已经显示过的历史消息
// （具体原因见 filterNewHistoryMessages 函数上面的注释）。
let lastHistoryTs = 0;

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
    img.dataset.caption = data.from ? `来自 ${data.from}` : '';
    img.addEventListener('click', () => openChatImageLightbox(img));
    bubble.appendChild(img);
  } else if (data.type === 'voice') {
    bubble.classList.add('voice-bubble');
    const audio = document.createElement('audio');
    audio.className = 'chat-voice';
    audio.src = data.audioUrl;
    audio.controls = true;
    audio.preload = 'metadata';
    bubble.appendChild(audio);
    if (data.durationSec) {
      const durationEl = document.createElement('span');
      durationEl.className = 'voice-duration';
      durationEl.textContent = formatVoiceDuration(data.durationSec);
      bubble.appendChild(durationEl);
    }
  } else {
    bubble.innerHTML = renderMarkdown(data.text);
    // Markdown 里 ![alt](url) 语法插入的行内图片，也要能点开 lightbox，
    // 和上面直接发送的图片共用同一套"翻遍所有图片"的逻辑。
    bubble.querySelectorAll('img.md-image').forEach((img) => {
      img.dataset.caption = data.from ? `来自 ${data.from}` : '';
      img.addEventListener('click', () => openChatImageLightbox(img));
    });
  }

  div.appendChild(bubble);
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  // 记录"目前为止渲染过的消息里最新的时间戳"，供 filterNewHistoryMessages() 在断线
  // 重连时过滤掉已经显示过的历史消息用（见该函数上面的注释）。这里不区分消息是通过
  // 实时的 chat-message 广播收到的、还是通过 chat-history 补齐的，两种来源都要算。
  if (data.ts && data.ts > lastHistoryTs) lastHistoryTs = data.ts;
}

function appendSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function appendHistoryDivider() {
  const div = document.createElement('div');
  div.className = 'history-divider';
  div.textContent = '以上是历史消息';
  chatMessages.appendChild(div);
  // 不在这里滚动：调用方（chat-history 的 socket 处理函数）已经统一负责滚动到底部了
}

// ==================== 历史消息去重（防断线重连重复渲染）====================
// Socket.IO 默认会自动重连（弱网抖动、手机切后台再切回来、切换 WiFi/蜂窝网络都可能
// 触发），每次重连都会重新走一遍 connect → join-room 流程，服务端也会照常把房间最近
// 的历史消息重新发一遍——这是有意为之的（断线期间对方发的新消息，唯一的补齐方式就是
// 靠重连时重新拉一次历史），不能简单粗暴地"只在第一次 join-room 时发历史"，否则断线
// 期间错过的消息就再也看不到了。
// 但如果客户端收到历史消息就无条件全部渲染，已经显示过的旧消息也会被重新渲染一遍，
// 聊天区看起来就像是"内容重复了"（还会跟着多一条"以上是历史消息"分隔线）。
// 用 lastHistoryTs（定义在上面 appendChatMessage 之前）过滤：只保留真正没见过的
// 新消息，断线期间错过的消息该补的还是会补上，已经看过的不会被重复渲染。
function filterNewHistoryMessages(messages) {
  if (!messages || messages.length === 0) return [];
  return messages.filter((msg) => !msg.ts || msg.ts > lastHistoryTs);
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
      // 插入表情后需要重新计算输入框高度（可能从空变多行、或反过来）。两个页面对
      // "怎么重新计算高度"的实现不完全一样（player.js 有专门的 autoResizeTextarea()，
      // 会强制不小于最小高度；chat.js 是内联的、没有最小高度下限），用 dispatch 一个
      // 'input' 事件来触发，而不是直接调用某个具体函数名——两个页面各自的
      // chatInput.addEventListener('input', ...) 监听器会接管后续处理，这样这份共享
      // 代码不需要关心页面各自的高度计算细节。
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

// ==================== 图片发送 ====================
imageBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', async () => {
  const file = imageInput.files[0];
  imageInput.value = '';
  if (!file) return;

  // 页面刚加载、getSocket() 还拿不到 socket 时（独立聊天室页面：/api/me 还没返回，
  // socket 还没建立；播放页：socket 是同步创建的，这个检查恒为 false，不影响播放页）。
  // 提前检查、给出明确提示，避免图片传上去了，但广播消息时因为 socket 不存在而
  // 静默失败——那样的话上传的文件谁也看不到，变成服务器上一个孤儿文件。
  const socket = _getSocket();
  if (!socket) { appendSystemMessage('连接尚未建立，请稍候再试'); return; }

  if (file.size > 5 * 1024 * 1024) { appendSystemMessage('图片不能超过 5MB'); return; }

  const formData = new FormData();
  formData.append('image', file);

  // "正在发送图片..." 只是临时状态提示，不应该和正式聊天记录一样永久留在聊天区里——
  // 发送成功后要把这条提示删掉（马上会收到 socket 广播回来的正式图片消息），
  // 失败的话就地把文字换成错误原因，而不是再叠加一条新的系统消息。
  const statusEl = appendSystemMessage('正在发送图片...');

  try {
    const res = await fetch('/api/chat-upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) { statusEl.textContent = data.error || '图片发送失败'; return; }

    statusEl.remove();
    socket.emit('chat-message', { videoId: _chatRoomId, type: 'image', imageUrl: data.url });
  } catch {
    statusEl.textContent = '图片发送失败，请检查网络';
  }
});

// ==================== 语音发送 ====================
// 点一下麦克风按钮开始录音，再点一下停止并发送；录音过程中会出现一个小的取消按钮，
// 点它可以放弃这段录音、不上传。60 秒会自动停止并发送，避免误触后忘记停止、录出一个超大文件。
let mediaRecorder = null;
let voiceChunks = [];
let voiceStartTime = 0;
let voiceTimerInterval = null;
let voiceStream = null;
let voiceCancelled = false;
const VOICE_MAX_DURATION_MS = 60 * 1000;
const VOICE_MIN_DURATION_MS = 800; // 太短基本是误触，直接丢弃、不上传

// 按优先级挑一个当前浏览器实际支持的录音格式：Chrome/Firefox 一般用 webm/opus，
// Safari 通常只支持 mp4。挑不到任何一个的话，交给 MediaRecorder 用默认格式
// （不同浏览器结果不同，但至少能录），真正的格式校验在服务端按文件魔数做。
function pickVoiceMimeType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function voiceExtFromMimeType(mimeType) {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4')) return 'm4a';
  return 'webm';
}

function formatRecordingTimer(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateVoiceTimerDisplay() {
  const elapsed = Date.now() - voiceStartTime;
  voiceTimer.textContent = formatRecordingTimer(elapsed);
  if (elapsed >= VOICE_MAX_DURATION_MS) stopVoiceRecording(true);
}

async function startVoiceRecording() {
  if (mediaRecorder) return; // 已经在录音中，忽略重复点击

  // 和图片发送同样的原因：页面刚加载时 socket 可能还没建立，提前检查，
  // 不要等用户录完一段语音、上传都成功了，才在广播消息时失败。
  const socket = _getSocket();
  if (!socket) { appendSystemMessage('连接尚未建立，请稍候再试'); return; }

  // 浏览器的 getUserMedia 只在"安全上下文"（HTTPS，或者 http://localhost）下才会暴露，
  // 普通的 http://IP地址 或 http://域名 访问会导致 navigator.mediaDevices 整个是 undefined，
  // 表现出来就是"不管什么浏览器/设备都提示不支持录音"——这其实不是浏览器不支持，
  // 而是访问方式不满足安全要求，单独给出更准确的提示，而不是笼统地说"不支持"。
  if (!window.isSecureContext) {
    appendSystemMessage('录音功能需要通过 HTTPS（或 localhost）访问，当前是不安全的 HTTP 连接，浏览器出于隐私安全考虑禁止了麦克风访问。请参考部署文档配置 HTTPS 反向代理后再试。');
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    appendSystemMessage('当前浏览器不支持录音功能');
    return;
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    appendSystemMessage('无法访问麦克风，请检查浏览器权限设置');
    return;
  }

  const mimeType = pickVoiceMimeType();
  try {
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch {
    appendSystemMessage('当前浏览器不支持录音，无法发送语音');
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  voiceStream = stream;
  voiceChunks = [];
  voiceCancelled = false;

  mediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) voiceChunks.push(e.data);
  });
  mediaRecorder.addEventListener('stop', onVoiceRecordingStop);

  mediaRecorder.start();
  voiceStartTime = Date.now();
  voiceBtn.classList.add('recording');
  voiceBtn.title = '停止并发送';
  voiceRecordingIndicator.hidden = false;
  voiceTimer.textContent = '0:00';
  voiceTimerInterval = setInterval(updateVoiceTimerDisplay, 250);
}

function stopVoiceRecording(shouldSend) {
  if (!mediaRecorder) return;
  voiceCancelled = !shouldSend;
  if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

async function onVoiceRecordingStop() {
  clearInterval(voiceTimerInterval);
  voiceTimerInterval = null;

  const durationMs = Date.now() - voiceStartTime;
  if (voiceStream) {
    voiceStream.getTracks().forEach((t) => t.stop()); // 释放麦克风占用
    voiceStream = null;
  }

  const chunks = voiceChunks;
  const mimeType = mediaRecorder.mimeType || 'audio/webm';
  const cancelled = voiceCancelled;
  voiceChunks = [];
  mediaRecorder = null;
  voiceCancelled = false;

  voiceBtn.classList.remove('recording');
  voiceBtn.title = '发送语音';
  voiceRecordingIndicator.hidden = true;

  if (cancelled) return;

  if (durationMs < VOICE_MIN_DURATION_MS) {
    appendSystemMessage('录音时间太短，已取消');
    return;
  }

  const blob = new Blob(chunks, { type: mimeType });
  if (blob.size === 0) return;
  if (blob.size > 8 * 1024 * 1024) {
    appendSystemMessage('语音文件过大，发送失败');
    return;
  }

  const durationSec = Math.round(durationMs / 1000);
  const formData = new FormData();
  formData.append('voice', blob, 'voice.' + voiceExtFromMimeType(mimeType));

  const statusEl = appendSystemMessage('正在发送语音...');
  try {
    const res = await fetch('/api/chat-voice-upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = data.error || '语音发送失败';
      return;
    }

    // 和图片发送保持同样的写法：先取一次局部变量再判空，而不是直接链式调用
    // _getSocket().emit(...)。实际运行中这里不会是 null（startVoiceRecording 开头
    // 已经检查过一次，socket 不会中途被重新置回 null），但万一以后有人改动了
    // getSocket 的实现、或者引入了 socket 会失效的场景，这样写不会直接抛出
    // "Cannot read properties of null" 而是走一条有提示的路径。
    // 注意判空要在 statusEl.remove() 之前做：失败时还要把"正在发送语音..."这条提示
    // 换成错误文案，如果先把元素从 DOM 里移除了，再改它的 textContent 用户是看不到的。
    const socket = _getSocket();
    if (!socket) {
      statusEl.textContent = '连接已断开，发送失败';
      return;
    }
    statusEl.remove();
    socket.emit('chat-message', { videoId: _chatRoomId, type: 'voice', audioUrl: data.url, durationSec });
  } catch {
    statusEl.textContent = '语音发送失败，请检查网络';
  }
}

voiceBtn.addEventListener('click', () => {
  if (mediaRecorder) {
    stopVoiceRecording(true);
  } else {
    startVoiceRecording();
  }
});

voiceCancelBtn.addEventListener('click', () => stopVoiceRecording(false));
