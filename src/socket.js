// 房间设计：room 名 = 视频 ID。两个人打开同一个视频就会进入同一个 room，
// 播放控制事件和聊天消息只在这个 room 内广播。
//
// 另外维护一个"大厅"概念：所有已登录的 socket 连接（无论是在视频列表页还是播放页）
// 都会被记录当前位置，广播给所有人，这样在列表页也能看到"对方正在看哪个视频"。

const { isValidChatImageFilename } = require('./chatUpload');

const ROOM_PREFIX = 'video:';
const LOBBY_ROOM = 'lobby';

const CHAT_HISTORY_MAX = 50; // 每个房间最多保留多少条聊天记录（内存里，重启会清空）

// ---- 简单的滑动窗口限流器：用于聊天消息和播放控制事件，防止脚本刷屏/恶意消耗 ----
// 返回的函数 isAllowed(key) 在限流范围内返回 true，超出范围返回 false。
function createRateLimiter(maxEvents, windowMs) {
  const records = new Map(); // key -> 时间戳数组

  // 定期清理早就过期、用不上的记录，避免 Map 无限增长
  setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of records.entries()) {
      const fresh = timestamps.filter((t) => now - t < windowMs);
      if (fresh.length === 0) records.delete(key);
      else records.set(key, fresh);
    }
  }, Math.max(windowMs, 30_000)).unref();

  return function isAllowed(key) {
    const now = Date.now();
    const timestamps = (records.get(key) || []).filter((t) => now - t < windowMs);
    if (timestamps.length >= maxEvents) {
      records.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    records.set(key, timestamps);
    return true;
  };
}

function initSocket(io) {
  const roomMembers = new Map(); // roomName -> Set(username)
  const roomHistory = new Map(); // roomName -> 最近的聊天消息数组（环形缓冲，最多 CHAT_HISTORY_MAX 条）

  // 关键：Socket.IO 在触发 'disconnect' 事件之前，会先把 socket.rooms 清空，
  // 所以不能在 disconnect 处理函数里用 socket.rooms 来判断"这个 socket 刚才在哪个房间"
  // （那样会永远查不到，导致"对方离开"的提示从来不会触发）。
  // 这里自己维护一份 socket.id -> 房间名 的映射，在 disconnect 时查这份映射。
  const socketCurrentRoom = new Map();

  // 大厅状态：username -> { videoId, videoName } | null（null 表示在列表页/空闲）
  const userLocations = new Map();
  // username -> Set(socket.id)，用于判断该用户是否还有其他连接在线（比如开了两个标签页）
  const userSockets = new Map();

  // 限流：聊天消息最多 10 条 / 5 秒；播放控制事件（含心跳）最多 30 个 / 5 秒。
  // 这两个上限都明显高于正常人类操作的速率，只会拦住失控脚本或异常重连风暴。
  const chatRateAllowed = createRateLimiter(10, 5000);
  const actionRateAllowed = createRateLimiter(30, 5000);

  // ---- 房间成员维护（之前误放在每次连接回调内部重新定义，挪到这里只定义一次） ----
  function addMember(room, user) {
    if (!roomMembers.has(room)) roomMembers.set(room, new Set());
    roomMembers.get(room).add(user);
  }

  function removeMember(room, user) {
    const set = roomMembers.get(room);
    if (!set) return;
    set.delete(user);
    if (set.size === 0) roomMembers.delete(room);
  }

  function pushHistory(room, msg) {
    const history = roomHistory.get(room) || [];
    history.push(msg);
    if (history.length > CHAT_HISTORY_MAX) history.shift();
    roomHistory.set(room, history);
  }

  function broadcastLobby() {
    const users = Array.from(userSockets.keys()).map((username) => ({
      username,
      online: userSockets.get(username).size > 0,
      location: userLocations.get(username) || null,
    }));
    io.to(LOBBY_ROOM).emit('lobby-presence', { users });
  }

  io.on('connection', (socket) => {
    const username = socket.user; // 由 server.js 里的 io.use() 鉴权中间件注入

    socket.join(LOBBY_ROOM);

    if (!userSockets.has(username)) userSockets.set(username, new Set());
    userSockets.get(username).add(socket.id);
    if (!userLocations.has(username)) userLocations.set(username, null);

    broadcastLobby();

    // 客户端在视频列表页时会发这个事件，表明"我现在没在看任何视频"
    socket.on('enter-lobby', () => {
      userLocations.set(username, null);
      broadcastLobby();
    });

    socket.on('join-room', ({ videoId, videoName }) => {
      if (!videoId || typeof videoId !== 'string') return;

      const room = ROOM_PREFIX + videoId;

      // 注意：这里是在 socket 仍连接的状态下读 socket.rooms，是准确的，
      // 和 disconnect 处理函数里的情况不同（那里 socket.rooms 已经被清空）。
      for (const r of socket.rooms) {
        if (r.startsWith(ROOM_PREFIX) && r !== room) {
          socket.leave(r);
          removeMember(r, username);
        }
      }

      socket.join(room);
      addMember(room, username);
      socketCurrentRoom.set(socket.id, room);

      const members = Array.from(roomMembers.get(room) || []);
      io.to(room).emit('room-presence', { members });

      socket.to(room).emit('chat-system', {
        text: `${username} 加入了观影房间`,
        ts: Date.now(),
      });

      // 把这个房间最近的聊天记录发给刚加入的这一个连接（不广播给其他人，他们早就看过了）
      const history = roomHistory.get(room) || [];
      if (history.length > 0) {
        socket.emit('chat-history', { messages: history });
      }

      // 更新大厅位置信息，让列表页也能看到"正在观看 XXX"
      userLocations.set(username, { videoId, videoName: videoName || '' });
      broadcastLobby();
    });

    // 播放控制：play / pause / seek / heartbeat
    socket.on('video-action', (data) => {
      if (!actionRateAllowed(username)) return; // 超出限流静默丢弃，不打扰用户

      const { videoId, action, time } = data || {};
      if (!videoId || !['play', 'pause', 'seek', 'heartbeat'].includes(action)) return;
      if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) return;

      const room = ROOM_PREFIX + videoId;
      socket.to(room).emit('video-action', { action, time, from: username, ts: Date.now() });
    });

    // 聊天消息：支持文本（含 Markdown 原文）和图片两种类型
    socket.on('chat-message', (data) => {
      if (!chatRateAllowed(username)) return; // 超出限流静默丢弃，不打扰用户

      const { videoId, type } = data || {};
      if (!videoId || typeof videoId !== 'string') return;

      const room = ROOM_PREFIX + videoId;

      if (type === 'image') {
        const { imageUrl } = data;
        // 再次校验图片 URL 格式，防止客户端伪造任意路径广播给对方
        const filename = typeof imageUrl === 'string' ? imageUrl.split('/').pop() : '';
        if (!isValidChatImageFilename(filename)) return;

        const msg = {
          from: username,
          type: 'image',
          imageUrl: `/chat-image/${filename}`,
          ts: Date.now(),
        };
        io.to(room).emit('chat-message', msg);
        pushHistory(room, msg);
        return;
      }

      // 默认当作文本消息处理
      const { text } = data;
      if (typeof text !== 'string') return;

      const trimmed = text.trim().slice(0, 2000); // 简单限长，避免刷屏/超大消息
      if (!trimmed) return;

      const msg = {
        from: username,
        type: 'text',
        text: trimmed,
        ts: Date.now(),
      };
      io.to(room).emit('chat-message', msg);
      pushHistory(room, msg);
    });

    socket.on('disconnect', () => {
      const room = socketCurrentRoom.get(socket.id);
      if (room) {
        removeMember(room, username);
        const members = Array.from(roomMembers.get(room) || []);
        io.to(room).emit('room-presence', { members });
        io.to(room).emit('chat-system', {
          text: `${username} 离开了观影房间`,
          ts: Date.now(),
        });
        socketCurrentRoom.delete(socket.id);
      }

      const sockets = userSockets.get(username);
      if (sockets) {
        sockets.delete(socket.id);
        if (sockets.size === 0) {
          userLocations.set(username, null);
        }
      }
      broadcastLobby();
    });
  });
}

module.exports = { initSocket };
