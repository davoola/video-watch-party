// 房间设计：room 名 = 视频 ID。两个人打开同一个视频就会进入同一个 room，
// 播放控制事件和聊天消息只在这个 room 内广播。
//
// 另外维护一个"大厅"概念：所有已登录的 socket 连接（无论是在视频列表页还是播放页）
// 都会被记录当前位置，广播给所有人，这样在列表页也能看到"对方正在看哪个视频"。

const path = require('path');
const { isValidChatImageFilename } = require('./chatUpload');
const { resolveVideoPath } = require('./videoScanner');

const ROOM_PREFIX = 'video:';
const LOBBY_ROOM = 'lobby';

// 独立聊天室页面（chat.html / public/js/chat.js）用的固定房间 ID，不对应任何真实视频文件。
// join-room 下面本来会用 videoId 反查真实视频文件名（防止 videoName 被伪造），
// 但这个 ID 从设计上就不是视频，反查必然失败，导致独立聊天室永远无法加入房间——
// 这里显式把它做成白名单特例，跳过"必须是真实视频"的校验。
// 注意要和 public/js/chat.js 里的 CHAT_ROOM_ID 保持完全一致。
const CHAT_LOBBY_ROOM_ID = '__lobby_chat__';
const CHAT_LOBBY_ROOM_NAME = '聊天室';

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
  // roomName -> Map<username, Set<socket.id>>。
  // 之前这里是 Map<roomName, Set<username>>，同一个用户开两个标签页都进同一个房间时，
  // 只要有一个标签页断开，就会把这个用户名从房间的成员集合里整个删掉——哪怕另一个标签页
  // 还在线，也会误触发"XX 离开了观影房间"的提示。改成按 socket.id 记录之后，
  // 只有当一个用户在某个房间里的所有连接都断开时，才真正判定为"离开"。
  const roomMembers = new Map();
  const roomHistory = new Map(); // roomName -> 最近的聊天消息数组（环形缓冲，最多 CHAT_HISTORY_MAX 条）
  // roomName -> { action, time, updatedAt }：记录房间最近一次的播放状态（播放/暂停/进度），
  // 这样两人都断线重连后，新加入的连接会先被同步到"大家上次看到哪"，而不是永远从头开始。
  // 注意这仍然只存在内存里，服务进程重启后会丢失——如果需要跨重启保留，可以在这里
  // 加一个定期写入磁盘/数据库的持久化层。
  const roomState = new Map();
  // roomName -> 房间成员清零那一刻的时间戳。用来给 roomHistory/roomState 做延迟清理：
  // 不能一空room就立刻删——两人都短暂断线重连、或者只是切换到别的视频再切回来，
  // 都会让房间"瞬间清零"，这时候恰恰是最需要保留历史/进度的场景。所以只清理那些
  // "已经空了很久"（STALE_ROOM_MS）的房间，兼顾"不无限增长"和"重连体验"两头。
  const roomLastEmptyAt = new Map();
  const STALE_ROOM_MS = 24 * 60 * 60 * 1000; // 房间空置超过 24 小时才清理其历史/进度缓存

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
  function addMember(room, user, socketId) {
    if (!roomMembers.has(room)) roomMembers.set(room, new Map());
    const users = roomMembers.get(room);
    if (!users.has(user)) users.set(user, new Set());
    users.get(user).add(socketId);
    roomLastEmptyAt.delete(room); // 房间又有人了，取消"待清理"标记
  }

  // 从房间里移除某一个 socket 连接；只有当这个用户在该房间里已经没有其它连接
  // （比如另一个标签页）时，才会把用户名从成员列表里摘除，并返回 true。
  // 调用方应该只在返回 true 时才广播"XX 离开了观影房间"这类系统消息。
  function removeMember(room, user, socketId) {
    const users = roomMembers.get(room);
    if (!users) return true;
    const sockets = users.get(user);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) users.delete(user);
    }
    if (users.size === 0) {
      roomMembers.delete(room);
      roomLastEmptyAt.set(room, Date.now()); // 记录清零时间，供下面的定期清理使用
    }
    return !users.has(user);
  }

  function getRoomMembers(room) {
    const users = roomMembers.get(room);
    return users ? Array.from(users.keys()) : [];
  }

  // 独立聊天室和普通视频房间共用同一套 join-room/disconnect 逻辑，
  // 但系统提示文案要分开："聊天室"用"加入/离开了聊天室"，视频房间用"...观影房间"，
  // 不能不管房间类型统一写死"观影房间"。
  function roomLabel(room) {
    return room === ROOM_PREFIX + CHAT_LOBBY_ROOM_ID ? '聊天室' : '观影房间';
  }

  // 定期清理长期空置的房间对应的聊天记录/播放进度缓存，避免"打开过的视频越多、
  // 内存占用越大、永远不会回落"。只清理已经空了超过 STALE_ROOM_MS 的房间——
  // 短暂断线重连、或者两人切换到别的视频又切回来，都不会触碰到这个阈值。
  setInterval(() => {
    const now = Date.now();
    for (const [room, emptyAt] of roomLastEmptyAt.entries()) {
      if (now - emptyAt >= STALE_ROOM_MS) {
        roomHistory.delete(room);
        roomState.delete(room);
        roomLastEmptyAt.delete(room);
      }
    }
  }, 60 * 60 * 1000).unref(); // 每小时扫一次，足够及时又不会太频繁

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
    const username = socket.request.session.user;
    const avatar = socket.request.session.avatar || null;

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

    socket.on('join-room', ({ videoId }) => {
      if (!videoId || typeof videoId !== 'string') return;

      let videoName;
      if (videoId === CHAT_LOBBY_ROOM_ID) {
        // 独立聊天室不是真实视频，不需要（也没法）反查文件名，直接用固定名字
        videoName = CHAT_LOBBY_ROOM_NAME;
      } else {
        // 视频名不再信任客户端传来的字段——之前直接把客户端传的 videoName 存进
        // userLocations 再广播给所有人，恶意客户端可以随意伪造文字显示在对方的
        // "对方正在观看"提示里。这里改成用 videoId 反查真实的视频文件名，
        // 查不到（视频不存在或无权访问）就直接忽略这次 join-room。
        const videoFullPath = resolveVideoPath(videoId);
        if (!videoFullPath) return;
        videoName = path.basename(videoFullPath);
      }

      const room = ROOM_PREFIX + videoId;

      // 注意：这里是在 socket 仍连接的状态下读 socket.rooms，是准确的，
      // 和 disconnect 处理函数里的情况不同（那里 socket.rooms 已经被清空）。
      for (const r of socket.rooms) {
        if (r.startsWith(ROOM_PREFIX) && r !== room) {
          socket.leave(r);
          const fullyLeft = removeMember(r, username, socket.id);
          io.to(r).emit('room-presence', { members: getRoomMembers(r) });
          if (fullyLeft) {
            socket.to(r).emit('chat-system', {
              text: `${username} 离开了${roomLabel(r)}`,
              ts: Date.now(),
            });
          }
        }
      }

      socket.join(room);
      addMember(room, username, socket.id);
      socketCurrentRoom.set(socket.id, room);

      io.to(room).emit('room-presence', { members: getRoomMembers(room) });

      socket.to(room).emit('chat-system', {
        text: `${username} 加入了${roomLabel(room)}`,
        ts: Date.now(),
      });

      // 把这个房间最近的聊天记录发给刚加入的这一个连接（不广播给其他人，他们早就看过了）
      const history = roomHistory.get(room) || [];
      if (history.length > 0) {
        socket.emit('chat-history', { messages: history });
      }

      // 把房间最近一次的播放状态（播放/暂停/进度）同步给刚加入的这一个连接，
      // 这样两人都断线重连后，不用再从头开始，会自动跳到大家上次看到的位置。
      const savedState = roomState.get(room);
      if (savedState) {
        socket.emit('video-action', {
          action: savedState.action,
          time: savedState.time,
          from: null,
          ts: Date.now(),
        });
      }

      // 更新大厅位置信息，让列表页也能看到"正在观看 XXX"
      userLocations.set(username, { videoId, videoName });
      broadcastLobby();
    });

    // 播放控制：play / pause / seek / heartbeat
    socket.on('video-action', (data) => {
      if (!actionRateAllowed(username)) return; // 超出限流静默丢弃，不打扰用户

      const { videoId, action, time } = data || {};
      if (!videoId || !['play', 'pause', 'seek', 'heartbeat'].includes(action)) return;
      if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) return;

      const room = ROOM_PREFIX + videoId;
      // 必须是真的通过 join-room 进过这个房间的连接，才允许对它发播放控制指令，
      // 否则任何知道 videoId 的客户端都能伪造播放/暂停/跳进度广播给房间里的人。
      if (socketCurrentRoom.get(socket.id) !== room) return;

      roomState.set(room, { action, time, updatedAt: Date.now() });
      socket.to(room).emit('video-action', { action, time, from: username, ts: Date.now() });
    });

    // 聊天消息：支持文本（含 Markdown 原文）和图片两种类型
    socket.on('chat-message', (data) => {
      if (!chatRateAllowed(username)) return; // 超出限流静默丢弃，不打扰用户

      const { videoId, type } = data || {};
      if (!videoId || typeof videoId !== 'string') return;

      const room = ROOM_PREFIX + videoId;
      // 必须是真的通过 join-room 进过这个房间的连接，才允许往这个房间发消息，
      // 否则任何知道 videoId 的客户端都能伪造消息写进 roomHistory，
      // 下次有人真正加入该房间时就会看到这些伪造的历史消息。
      if (socketCurrentRoom.get(socket.id) !== room) return;

      if (type === 'image') {
        const { imageUrl } = data;
        // 再次校验图片 URL 格式，防止客户端伪造任意路径广播给对方
        const filename = typeof imageUrl === 'string' ? imageUrl.split('/').pop() : '';
        if (!isValidChatImageFilename(filename)) return;

        const msg = {
          from: username,
          avatar,
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
        avatar,
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
        const fullyLeft = removeMember(room, username, socket.id);
        io.to(room).emit('room-presence', { members: getRoomMembers(room) });
        if (fullyLeft) {
          // 只有这个用户在房间里的所有连接都断开了，才广播"离开了..."，
          // 避免同一个人开着两个标签页时，关掉其中一个就被误判成"离开"（见上面的说明）。
          io.to(room).emit('chat-system', {
            text: `${username} 离开了${roomLabel(room)}`,
            ts: Date.now(),
          });
        }
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
