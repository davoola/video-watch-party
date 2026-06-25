// 极简、安全的 Markdown 子集渲染器，专为聊天消息设计。
//
// 安全原则：
// 1. 永远先对原始文本做 HTML 转义，再叠加我们自己可控的标签（<strong>/<em>/<del>/<code>/<a>）。
//    这样即使用户输入里包含 <script> 之类的内容，也只会被当成纯文本显示，不会被当成标签解析。
// 2. 不支持任意 HTML、不支持 [text](url) 链接语法、不支持 javascript: 等协议—— 
//    只自动识别以 http:// 或 https:// 开头的链接，从根源上避免链接语法被用来注入恶意协议。
// 3. 不支持标题/列表/表格等"重格式"，聊天场景不需要，也减少了正则之间互相干扰导致逃逸的可能性。

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(raw) {
  if (typeof raw !== 'string') return '';

  let text = escapeHtml(raw);

  // 行内代码 `code`：最先处理，避免代码块内容被后续的粗体/斜体规则误处理
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // 粗体 **text** / __text__
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');

  // 斜体 *text* / _text_（放在粗体之后处理，避免吞掉 ** 配对）
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  text = text.replace(/_([^_\n]+)_/g, '<em>$1</em>');

  // 删除线 ~~text~~
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 自动链接：只认 http(s) 开头，且此时文本已被转义过，
  // 插入到 href="$1" 里不会出现真实引号字符，无法跳出属性边界。
  text = text.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 换行
  text = text.replace(/\n/g, '<br>');

  return text;
}

// Node (CommonJS, 用于测试) 和浏览器 (全局变量, 没有打包工具) 两种环境都能用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, renderMarkdown };
}
