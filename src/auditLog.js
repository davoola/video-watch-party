const { getDb } = require('./db');

function getClientIp(req) {
  if (!req) return 'unknown';
  const xf = req.headers && req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    return xf.split(',')[0].trim();
  }
  if (req.ip) return req.ip;
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

function getSocketIp(socket) {
  try {
    if (socket.handshake && socket.handshake.address) return socket.handshake.address;
    if (socket.request) return getClientIp(socket.request);
  } catch (_) {
    /* ignore */
  }
  return 'unknown';
}

/**
 * @param {{ actor: string, action: string, objectType?: string, summary?: string, ip?: string }} entry
 */
function writeAuditLog(entry) {
  try {
    const actor = entry.actor || '';
    const action = entry.action || '';
    if (!actor || !action) return;
    getDb()
      .prepare(
        `INSERT INTO audit_logs (ts, actor, action, object_type, summary, ip)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        Date.now(),
        String(actor).slice(0, 64),
        String(action).slice(0, 64),
        entry.objectType ? String(entry.objectType).slice(0, 64) : null,
        entry.summary ? String(entry.summary).slice(0, 500) : null,
        entry.ip ? String(entry.ip).slice(0, 128) : null
      );
  } catch (err) {
    console.error('写入审计日志失败:', err.message);
  }
}

function listAuditLogs({ limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const rows = getDb()
    .prepare(
      `SELECT id, ts, actor, action, object_type AS objectType, summary, ip
       FROM audit_logs
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    )
    .all(safeLimit, safeOffset);
  const total = getDb().prepare(`SELECT COUNT(*) AS c FROM audit_logs`).get().c;
  return { rows, total, limit: safeLimit, offset: safeOffset };
}

/** 删除早于 beforeTs 的日志；beforeTs 为空则清空全部 */
function purgeAuditLogs(beforeTs) {
  if (beforeTs == null) {
    const info = getDb().prepare(`DELETE FROM audit_logs`).run();
    return info.changes;
  }
  const info = getDb().prepare(`DELETE FROM audit_logs WHERE ts < ?`).run(beforeTs);
  return info.changes;
}

module.exports = {
  getClientIp,
  getSocketIp,
  writeAuditLog,
  listAuditLogs,
  purgeAuditLogs,
};
