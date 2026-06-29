// 聊天消息的 Markdown 渲染器（含块级结构 + 行内格式）。
//
// 安全原则（务必先读这一段，再改下面的代码）：
// 1. 永远先对原始文本做 HTML 转义，再叠加我们自己生成、自己可控的标签。
//    这样即使用户输入里包含 <script> 之类的内容，也只会被当成纯文本显示。
// 2. 链接 [text](url) 和图片 ![alt](url) 必须校验 URL 协议头（只准 http/https，
//    链接额外允许 mailto），拒绝 javascript: 等危险协议——否则点击/加载就可能执行任意脚本。
// 3. <details>/<summary> 折叠面板不是"放行任意 HTML"，而是只精确识别这 4 个
//    不带任何属性的标签字符串本身。任何变体（带 class、带 onclick、带空格等）
//    都不会被识别，会保持转义后的纯文本显示——这是故意的，缩小攻击面。
// 4. 已经生成好的安全 HTML（代码、链接、图片）用占位符暂存，避免被后续规则
//    （尤其是自动识别裸 URL 的规则）重复处理，导致标签被破坏或被嵌套套娃。

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 链接允许的协议：http/https/mailto。图片不允许 mailto（没有意义）。
function isSafeLinkUrl(url) {
  return /^(https?:|mailto:)/i.test(url);
}
function isSafeImageUrl(url) {
  return /^https?:/i.test(url);
}

// 只白名单这 4 个精确的、不带任何属性的转义后标签字符串，其余一律不识别。
function unescapeDetailsTags(text) {
  return text
    .replace(/&lt;details&gt;/gi, '<details>')
    .replace(/&lt;summary&gt;/gi, '<summary>')
    .replace(/&lt;\/summary&gt;/gi, '</summary>')
    .replace(/&lt;\/details&gt;/gi, '</details>');
}

// ---- 行内级格式：代码、图片、链接、粗体、斜体、删除线、自动链接 ----
// includeBlockLevelExtras=true 时才处理图片（块级渲染场景使用）；
// 弹幕场景调用时传 false，避免飞行的弹幕里突然冒出一张图片把布局挤坏。
function applyInline(line, includeImages) {
  const placeholders = [];
  const save = (html) => {
    const token = '\u0000' + placeholders.length + '\u0000';
    placeholders.push(html);
    return token;
  };

  let text = line;

  // 行内代码 `code`：最先处理并占位保护，避免内容被后面的粗体/斜体/链接规则误处理。
  // 注意：这里的 code 此时已经是 escapeHtml() 处理过的转义文本了
  // （applyInline 收到的 line 参数，调用方在更早的 renderMarkdown/renderInlineMarkdown 里
  // 已经对整段原始输入做过一次 escapeHtml），所以直接拼进 <code>...</code> 是安全的，
  // 不需要在这里再转义一次——这行注释就是为了避免日后有人看不出这一点，误加或误删转义逻辑。
  text = text.replace(/`([^`\n]+)`/g, (_, code) => save('<code>' + code + '</code>'));

  // 图片 ![alt](url) —— 必须在链接规则之前处理，否则会被链接规则提前吃掉语法结构
  if (includeImages) {
    text = text.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (whole, alt, url) => {
      if (!isSafeImageUrl(url)) return whole; // 协议不安全：保持原样的转义文本，不渲染成图片
      return save('<img src="' + url + '" alt="' + alt + '" class="md-image" loading="lazy">');
    });
  }

  // 链接 [text](url)
  text = text.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (whole, label, url) => {
    if (!isSafeLinkUrl(url)) return whole; // 协议不安全：保持原样的转义文本，不渲染成链接
    return save('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
  });

  // 粗体 **text** / __text__
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');

  // 斜体 *text* / _text_（放在粗体之后处理，避免吞掉 ** 配对）
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  text = text.replace(/_([^_\n]+)_/g, '<em>$1</em>');

  // 删除线 ~~text~~
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 自动链接：识别裸 URL（没有用 [text](url) 包裹的）。
  // 因为上面的链接/图片已经被替换成占位符（不再是文本里的真实字符），
  // 这里不会重复处理、也不会把已生成的 <a>/<img> 标签内容误当成裸 URL 再包一层。
  text = text.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => save('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>')
  );

  // 把占位符换回真正生成的 HTML
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => placeholders[Number(i)]);

  return text;
}

// ---- 块级辅助：判断/拆解每一行属于哪种结构 ----

function isHr(line) {
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim());
}

function matchHeading(line) {
  const m = line.match(/^(#{1,6})\s+(.+)$/);
  return m ? { level: m[1].length, content: m[2] } : null;
}

function matchBlockquote(line) {
  // 注意：此时传入的 line 已经经过 escapeHtml 处理，原始的 ">" 字符已经变成了 "&gt;"，
  // 所以这里要匹配转义后的形式，不能匹配字面的 ">"（那样永远不会命中）。
  const m = line.match(/^&gt;\s?(.*)$/);
  return m ? m[1] : null;
}

function matchListItem(line) {
  const m = line.match(/^(?:([-*])|(\d+)\.)\s+(.*)$/);
  if (!m) return null;
  const ordered = m[2] !== undefined;
  const content = m[3];
  const task = content.match(/^\[( |x|X)\]\s+(.*)$/);
  if (task) {
    return { ordered, task: true, checked: task[1].toLowerCase() === 'x', content: task[2] };
  }
  return { ordered, task: false, content };
}

function isTableSeparatorRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(trimmed);
}

function splitTableRow(line) {
  let cells = line.trim();
  if (cells.startsWith('|')) cells = cells.slice(1);
  if (cells.endsWith('|')) cells = cells.slice(0, -1);
  return cells.split('|').map((c) => c.trim());
}

function isPlainTableRow(line) {
  return line.includes('|') && line.trim() !== '';
}

// 判断一行是否会被某种"块级结构"开头吃掉（用于决定普通文本行该在哪里截断）
function startsNewBlock(lines, i) {
  const line = lines[i];
  if (isHr(line)) return true;
  if (matchHeading(line)) return true;
  if (matchBlockquote(line) !== null) return true;
  if (matchListItem(line)) return true;
  if (i + 1 < lines.length && isPlainTableRow(line) && isTableSeparatorRow(lines[i + 1])) return true;
  return false;
}

// ---- 主渲染函数：先按块分组，再对每块内部做行内处理 ----
function renderMarkdown(raw) {
  if (typeof raw !== 'string') return '';

  // 防御性清理：占位符机制用 \u0000 作分隔符，提前清掉输入里可能混入的同字符，
  // 避免极端情况下和内部占位符标记产生混淆（最坏情况只是渲染错位，不构成 XSS，但还是清掉更稳妥）。
  let text = raw.replace(/\u0000/g, '');
  text = escapeHtml(text);
  text = unescapeDetailsTags(text);

  const lines = text.split('\n');
  const htmlParts = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 表格：当前行像表头，下一行是分隔线（---|---），才认定为表格
    if (i + 1 < lines.length && isPlainTableRow(line) && isTableSeparatorRow(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && isPlainTableRow(lines[i])) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }
      const thead = '<tr>' + headerCells.map((c) => '<th>' + applyInline(c, true) + '</th>').join('') + '</tr>';
      const tbody = bodyRows
        .map((row) => '<tr>' + row.map((c) => '<td>' + applyInline(c, true) + '</td>').join('') + '</tr>')
        .join('');
      htmlParts.push('<div class="md-table-wrap"><table class="md-table"><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div>');
      continue;
    }

    // 分隔线
    if (isHr(line)) {
      htmlParts.push('<hr class="md-hr">');
      i++;
      continue;
    }

    // 标题
    const heading = matchHeading(line);
    if (heading) {
      const tag = 'h' + heading.level;
      htmlParts.push('<' + tag + ' class="md-heading">' + applyInline(heading.content, true) + '</' + tag + '>');
      i++;
      continue;
    }

    // 引用块：连续的 > 行合并成一个 blockquote
    if (matchBlockquote(line) !== null) {
      const quoteLines = [];
      while (i < lines.length && matchBlockquote(lines[i]) !== null) {
        quoteLines.push(applyInline(matchBlockquote(lines[i]), true));
        i++;
      }
      htmlParts.push('<blockquote class="md-quote">' + quoteLines.join('<br>') + '</blockquote>');
      continue;
    }

    // 列表（含任务列表）：连续的同类型（有序/无序）列表项合并成一个 ul/ol
    const firstItem = matchListItem(line);
    if (firstItem) {
      const ordered = firstItem.ordered;
      const items = [];
      while (i < lines.length) {
        const item = matchListItem(lines[i]);
        if (!item || item.ordered !== ordered) break;
        items.push(item);
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      const itemsHtml = items
        .map((it) => {
          if (it.task) {
            const checkedAttr = it.checked ? ' checked' : '';
            return '<li class="md-task"><input type="checkbox" disabled' + checkedAttr + '> ' + applyInline(it.content, true) + '</li>';
          }
          return '<li>' + applyInline(it.content, true) + '</li>';
        })
        .join('');
      htmlParts.push('<' + tag + ' class="md-list">' + itemsHtml + '</' + tag + '>');
      continue;
    }

    // 普通文本行：和后续的普通文本行合并，用 <br> 连接，直到遇到新的块结构起始行
    const textLines = [];
    while (i < lines.length && !startsNewBlock(lines, i)) {
      textLines.push(applyInline(lines[i], true));
      i++;
    }
    htmlParts.push(textLines.join('<br>'));
  }

  return htmlParts.join('');
}

// 弹幕专用：只做行内格式（粗体/斜体/删除线/代码/链接/自动链接），
// 不处理标题/列表/表格/引用/分隔线/图片/折叠面板这些块级或重量级结构——
// 弹幕是一行飞过屏幕的文字，塞进表格或图片只会破坏布局，索性在这一层就不支持。
function renderInlineMarkdown(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/\u0000/g, '');
  text = escapeHtml(text);
  // 折叠面板对飞行文字没有意义，也不在这里识别 <details>/<summary>
  return applyInline(text.replace(/\n/g, ' '), false);
}

// Node (CommonJS, 用于测试) 和浏览器 (全局变量, 没有打包工具) 两种环境都能用
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, renderMarkdown, renderInlineMarkdown };
}
