const meText = document.getElementById('meText');
const auditTbody = document.getElementById('auditTbody');
const auditError = document.getElementById('auditError');
const auditTotal = document.getElementById('auditTotal');
const pageInfo = document.getElementById('pageInfo');

const PAGE_SIZE = 50;
let offset = 0;
let total = 0;

const ACTION_LABELS = {
  login: '登录',
  logout: '退出',
  enter_video: '进入视频',
  leave_video: '离开视频',
  enter_chat: '进入聊天',
  leave_chat: '离开聊天',
  purge_logs: '清理日志',
  db_checkpoint: '写入主文件',
  db_backup: '备份数据库',
};

const TYPE_LABELS = {
  session: '会话',
  video: '视频',
  chat: '聊天',
  audit: '审计',
  database: '数据库',
};

function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function ensureAdmin() {
  const res = await fetch('/api/me');
  if (!res.ok) {
    window.location.href = '/login.html';
    return null;
  }
  const data = await res.json();
  if (data.role !== 'admin') {
    window.location.href = '/index.html';
    return null;
  }
  meText.textContent = data.displayName || data.username;
  return data;
}

async function loadLogs() {
  auditError.textContent = '';
  try {
    const res = await fetch(`/api/admin/audit-logs?limit=${PAGE_SIZE}&offset=${offset}`);
    const data = await res.json();
    if (!res.ok) {
      auditError.textContent = data.error || '加载失败';
      return;
    }
    total = data.total || 0;
    auditTotal.textContent = `共 ${total} 条`;
    const page = Math.floor(offset / PAGE_SIZE) + 1;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    pageInfo.textContent = `${page} / ${pages}`;

    const rows = data.rows || [];
    if (rows.length === 0) {
      auditTbody.innerHTML = '<tr><td colspan="7" class="empty-state">暂无日志</td></tr>';
      return;
    }
    auditTbody.innerHTML = rows
      .map(
        (r) => `<tr>
        <td>${r.id}</td>
        <td>${escapeHtml(formatTime(r.ts))}</td>
        <td>${escapeHtml(r.actor)}</td>
        <td>${escapeHtml(ACTION_LABELS[r.action] || r.action)}</td>
        <td>${escapeHtml(TYPE_LABELS[r.objectType] || r.objectType || '—')}</td>
        <td class="audit-summary">${escapeHtml(r.summary || '—')}</td>
        <td>${escapeHtml(r.ip || '—')}</td>
      </tr>`
      )
      .join('');
  } catch {
    auditError.textContent = '网络错误';
  }
}

document.getElementById('refreshAuditBtn').addEventListener('click', () => loadLogs());
document.getElementById('prevPageBtn').addEventListener('click', () => {
  if (offset <= 0) return;
  offset = Math.max(0, offset - PAGE_SIZE);
  loadLogs();
});
document.getElementById('nextPageBtn').addEventListener('click', () => {
  if (offset + PAGE_SIZE >= total) return;
  offset += PAGE_SIZE;
  loadLogs();
});

(async () => {
  const me = await ensureAdmin();
  if (!me) return;
  await loadLogs();
})();
