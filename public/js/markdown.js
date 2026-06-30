// 聊天消息的 Markdown 渲染器（完整语法支持版）。
//
// ────────── 安全原则，改动前必读 ──────────
// 1. 永远先对原始文本做 HTML 转义，再叠加我们自己生成、自己可控的标签。
//    这样即使用户输入里包含 <script> 之类的内容，也只会被当成纯文本显示。
// 2. 链接/图片 URL 必须校验协议头（只准 http/https，链接额外允许 mailto），
//    拒绝 javascript: 等危险协议。
// 3. <details>/<summary> 只精确白名单这 4 个不带任何属性的标签字符串，
//    任何变体（带 class、带 onclick 等）都不会被识别，保持转义后的纯文本。
// 4. 已生成好的安全 HTML（代码块、行内代码、数学公式、链接、图片）全部用
//    占位符暂存，避免被后续规则重复处理或互相干扰。
// 5. 代码块和数学公式在所有其他规则之前处理，防止其内容被行内格式规则二次解析。
//
// ────────── 支持的语法 ──────────
// 块级：代码块(```), 数学块($$), 标题(#~######), 引用(> 多级), 有序/无序/任务多级列表,
//       表格(含列对齐), 分隔线(---/***), 折叠面板(<details>)
// 行内：行内代码(`), 行内数学($), 粗体(**), 斜体(*), 删除线(~~), 图片(![]), 链接([]),
//       自动链接(https://...)

'use strict';

// ─────────────────────────────────────────
// 基础安全工具
// ─────────────────────────────────────────
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

// ─────────────────────────────────────────
// 占位符池：把已生成的安全 HTML 暂存，换成不会被后续规则误处理的唯一令牌
// ─────────────────────────────────────────
function createPlaceholderPool() {
  const store = [];
  const save = (html) => {
    const token = '\u0000' + store.length + '\u0000';
    store.push(html);
    return token;
  };
  const restore = (text) =>
    text.replace(/\u0000(\d+)\u0000/g, (_, i) => store[Number(i)]);
  return { save, restore };
}

// ─────────────────────────────────────────
// 行内格式渲染（对单行/行片段运行）
// ─────────────────────────────────────────
function applyInline(line, pool, includeImages) {
  const { save } = pool;
  let text = line;

  // 行内代码 `code`（已经是 escapeHtml 过的文本，直接拼接安全）
  text = text.replace(/`([^`\n]+)`/g, (_, code) => save('<code>' + code + '</code>'));

  // 行内数学公式 $formula$（用 <code class="math-inline"> 展示，不引入外部库）
  text = text.replace(/\$([^$\n]+)\$/g, (_, math) =>
    save('<code class="math-inline">' + math + '</code>')
  );

  // 图片 ![alt](url) —— 必须在链接规则之前处理
  if (includeImages) {
    text = text.replace(/!\[([^\]\n]*)\]\(([^)\n]+)\)/g, (whole, alt, url) => {
      if (!isSafeImageUrl(url)) return whole;
      return save('<img src="' + url + '" alt="' + alt + '" class="md-image" loading="lazy">');
    });
  }

  // 链接 [text](url)
  text = text.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (whole, label, url) => {
    if (!isSafeLinkUrl(url)) return whole;
    return save('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>');
  });

  // 粗体 **text** / __text__
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');

  // 斜体 *text* / _text_（在粗体之后处理）
  text = text.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  text = text.replace(/_([^_\n]+)_/g, '<em>$1</em>');

  // 删除线 ~~text~~
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 自动链接（裸 URL）：因为链接/图片已替换成占位符，这里不会二次处理
  text = text.replace(
    /(https?:\/\/[^\s<]+)/g,
    (url) => save('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>')
  );

  return text;
}

// ─────────────────────────────────────────
// 表格辅助
// ─────────────────────────────────────────

/**
 * 解析分隔行，返回每列的对齐方式数组（'left' | 'center' | 'right' | ''）
 * 分隔行示例：| :--- | :---: | ---: |
 */
function parseAlignments(sepLine) {
  let cells = sepLine.trim();
  if (cells.startsWith('|')) cells = cells.slice(1);
  if (cells.endsWith('|')) cells = cells.slice(0, -1);
  return cells.split('|').map((cell) => {
    const c = cell.trim();
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
}

function splitTableRow(line) {
  let cells = line.trim();
  if (cells.startsWith('|')) cells = cells.slice(1);
  if (cells.endsWith('|')) cells = cells.slice(0, -1);
  return cells.split('|').map((c) => c.trim());
}

function isTableSeparatorRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('-')) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(trimmed);
}

function isPlainTableRow(line) {
  return line.includes('|') && line.trim() !== '';
}

// ─────────────────────────────────────────
// 引用块辅助（支持多级 >>）
// 注意：此时文本已经 escapeHtml，> 已变成 &gt;
// ─────────────────────────────────────────

/**
 * 返回这一行的引用前缀级别（0 表示不是引用）和去掉前缀后的内容
 * 例如 "&gt;&gt; text" => { level: 2, content: "text" }
 */
function matchBlockquote(line) {
  const m = line.match(/^((?:&gt;\s?)+)(.*)$/);
  if (!m) return null;
  // 数 &gt; 的个数
  const level = (m[1].match(/&gt;/g) || []).length;
  return { level, content: m[2] };
}

/**
 * 把一组 { level, content } 行递归渲染成嵌套 blockquote
 */
function renderQuoteLines(lines, pool) {
  if (lines.length === 0) return '';

  // 第一级引用：提取当前层的内容行（level >= 1），把 level 减 1 得到子级
  const inner = lines.map((l) => ({ level: l.level - 1, content: l.content }));

  // 分出"需要继续嵌套的行"（原来 level >= 2）
  const singleLevel = [];
  let i = 0;
  let result = '';

  while (i < inner.length) {
    if (inner[i].level === 0) {
      // 普通行，直接行内渲染
      singleLevel.push(applyInline(inner[i].content, pool, true));
      i++;
    } else {
      // 有子级，先 flush 已积累的单行，再递归渲染子级块
      if (singleLevel.length > 0) {
        result += singleLevel.join('<br>');
        singleLevel.length = 0;
      }
      // 收集连续的子级行
      const subLines = [];
      while (i < inner.length && inner[i].level > 0) {
        subLines.push(inner[i]);
        i++;
      }
      result += renderQuoteLines(subLines, pool);
    }
  }
  if (singleLevel.length > 0) {
    result += singleLevel.join('<br>');
  }

  return '<blockquote class="md-quote">' + result + '</blockquote>';
}

// ─────────────────────────────────────────
// 列表辅助（支持多级嵌套，识别缩进）
// ─────────────────────────────────────────

/**
 * 检测一行的缩进级别（每 2 个空格或 1 个 Tab 算一级）和列表类型
 * 返回 null 表示不是列表行
 */
function matchListItemWithIndent(line) {
  const m = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
  if (!m) return null;
  const indent = m[1];
  // 以 2 个空格或 1 个 tab 为一级，向下取整
  const level = indent.includes('\t')
    ? indent.split('').filter((c) => c === '\t').length
    : Math.floor(indent.length / 2);
  const ordered = /^\d+\.$/.test(m[2]);
  const rawContent = m[3];
  const task = rawContent.match(/^\[( |x|X)\]\s+(.*)$/);
  return {
    level,
    ordered,
    task: !!task,
    checked: task ? task[1].toLowerCase() === 'x' : false,
    content: task ? task[2] : rawContent,
  };
}

/**
 * 把一组扁平的列表项（带 level 字段）递归渲染成嵌套 ul/ol
 * @param {Array} items - [{ level, ordered, task, checked, content }, ...]
 * @param {number} depth - 当前处理的深度
 * @param {Object} pool  - 占位符池
 */
function renderListItems(items, depth, pool) {
  if (items.length === 0) return '';

  let html = '';
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    if (item.level !== depth) { i++; continue; }

    // 收集这个列表项的直接子项（level > depth 的连续行）
    const children = [];
    let j = i + 1;
    while (j < items.length && items[j].level > depth) {
      children.push(items[j]);
      j++;
    }

    const contentHtml = applyInline(item.content, pool, true);
    let liHtml = '';
    if (item.task) {
      liHtml = '<li class="md-task"><input type="checkbox" disabled' +
        (item.checked ? ' checked' : '') + '> ' + contentHtml;
    } else {
      liHtml = '<li>' + contentHtml;
    }

    if (children.length > 0) {
      liHtml += renderNestedList(children, depth + 1, pool);
    }
    liHtml += '</li>';
    html += liHtml;
    i = j;
  }
  return html;
}

/**
 * 给一组子项确定用 ul 还是 ol 来包裹，再递归生成列表 HTML
 */
function renderNestedList(items, depth, pool) {
  if (items.length === 0) return '';
  // 以第一个 item 的 ordered 属性决定标签
  const topItems = items.filter((it) => it.level === depth);
  if (topItems.length === 0) return '';
  const tag = topItems[0].ordered ? 'ol' : 'ul';
  return '<' + tag + ' class="md-list">' + renderListItems(items, depth, pool) + '</' + tag + '>';
}

// ─────────────────────────────────────────
// 代码块提取（预处理阶段，在 escapeHtml 之前）
// ─────────────────────────────────────────

/**
 * 在对整段文本做 escapeHtml 之前，先把代码块和数学块提取出来，
 * 换成占位符，避免其内容被转义规则或行内格式规则处理。
 *
 * 重要细节：生成的 HTML 内部如果包含真实的 "\n"，会在后续按行扫描
 * （text.split('\n')）阶段被错误地当成"新的一行"处理，导致代码块/数学块
 * 被切碎、插入意外的 <p> 标签。所以这里生成 HTML 时，把内部真实换行符
 * 先换成一个不会和普通换行混淆的标记 "\u0002"，等整个块级扫描流程结束后
 * （在 renderMarkdown 末尾）再统一换回真正的 "\n"，让浏览器在 <pre> 里正常折行。
 *
 * 返回 { processed: string, blocks: Map<token, html> }
 */
function extractBlocks(raw) {
  const blocks = new Map();
  let counter = 0;
  let text = raw;

  const NEWLINE_GUARD = '\u0002';

  // 数学块 $$...$$（多行）
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const token = '\u0001block' + (counter++) + '\u0001';
    const escaped = escapeHtml(math.trim()).replace(/\n/g, NEWLINE_GUARD);
    blocks.set(token, '<pre class="math-block"><code>' + escaped + '</code></pre>');
    return token;
  });

  // 代码块 ```lang\n...\n```
  text = text.replace(/```([^\n]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const token = '\u0001block' + (counter++) + '\u0001';
    const langAttr = lang.trim() ? ' class="language-' + escapeHtml(lang.trim()) + '"' : '';
    // 去掉代码内容末尾紧贴着结束 ``` 之前的那一个换行符（书写惯例：```\ncode\n``` 中最后一个 \n 不属于代码本身）
    const trimmedCode = code.replace(/\n$/, '');
    const escaped = escapeHtml(trimmedCode).replace(/\n/g, NEWLINE_GUARD);
    blocks.set(token, '<pre class="md-code-block"><code' + langAttr + '>' + escaped + '</code></pre>');
    return token;
  });

  return { text, blocks };
}

// ─────────────────────────────────────────
// 主块级渲染
// ─────────────────────────────────────────

/**
 * 判断一行是否开始了一种新的块结构（用于截断普通文本段落的收集）
 */
function startsNewBlock(lines, i) {
  const line = lines[i];
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim())) return true;   // HR
  if (/^#{1,6}\s/.test(line)) return true;                            // 标题
  if (/^(?:&gt;\s?)+/.test(line)) return true;                        // 引用（已转义）
  if (/^\s*([-*]|\d+\.)\s/.test(line)) return true;                   // 列表
  if (i + 1 < lines.length && isPlainTableRow(line) && isTableSeparatorRow(lines[i + 1])) return true;
  return false;
}

function isHr(line) {
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim());
}

// ─────────────────────────────────────────
// 对外暴露的主渲染函数
// ─────────────────────────────────────────
function renderMarkdown(raw) {
  if (typeof raw !== 'string') return '';

  // 防御性清理：占位符用 \u0000/\u0001/\u0002 作分隔符，提前清掉输入里可能混入的同字符
  raw = raw.replace(/[\u0000\u0001\u0002]/g, '');

  // ── 第一步：提取代码块和数学块（在 escapeHtml 之前），换成特殊占位符 ──
  const { text: afterExtract, blocks } = extractBlocks(raw);

  // ── 第二步：对剩余文本做 HTML 转义，再恢复折叠面板标签 ──
  let text = escapeHtml(afterExtract);
  text = unescapeDetailsTags(text);

  // ── 第三步：把块占位符恢复（它们的 HTML 已经在 extractBlocks 里生成好了） ──
  // 先按行拆分，但代码块/数学块占位符可能跨行——先整体恢复再拆行
  text = text.replace(/\u0001block\d+\u0001/g, (token) => {
    // escapeHtml 会对 \u0001 进制包含的内容做转义，但 \u0001 本身不在转义字符集里，安全
    return blocks.get(token) || token;
  });

  const lines = text.split('\n');
  const pool = createPlaceholderPool();
  const htmlParts = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 已经处理好的代码块/数学块 HTML 直接输出（可能一行就是整个 <pre>...</pre>）
    if (/<pre\s/.test(line) || line.startsWith('<pre>')) {
      htmlParts.push(line);
      i++;
      continue;
    }

    // 表格
    if (i + 1 < lines.length && isPlainTableRow(line) && isTableSeparatorRow(lines[i + 1])) {
      const headerCells = splitTableRow(line);
      const alignments = parseAlignments(lines[i + 1]);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && isPlainTableRow(lines[i])) {
        bodyRows.push(splitTableRow(lines[i]));
        i++;
      }

      const makeTh = (c, idx) => {
        const align = alignments[idx];
        const style = align ? ' style="text-align:' + align + '"' : '';
        return '<th' + style + '>' + applyInline(c, pool, true) + '</th>';
      };
      const makeTd = (c, idx) => {
        const align = alignments[idx];
        const style = align ? ' style="text-align:' + align + '"' : '';
        return '<td' + style + '>' + applyInline(c, pool, true) + '</td>';
      };

      const thead = '<tr>' + headerCells.map(makeTh).join('') + '</tr>';
      const tbody = bodyRows.map((row) => '<tr>' + row.map(makeTd).join('') + '</tr>').join('');
      htmlParts.push(
        '<div class="md-table-wrap"><table class="md-table"><thead>' +
        thead + '</thead><tbody>' + tbody + '</tbody></table></div>'
      );
      continue;
    }

    // 分隔线
    if (isHr(line)) {
      htmlParts.push('<hr class="md-hr">');
      i++;
      continue;
    }

    // 标题
    const hMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (hMatch) {
      const tag = 'h' + hMatch[1].length;
      htmlParts.push('<' + tag + ' class="md-heading">' + applyInline(hMatch[2], pool, true) + '</' + tag + '>');
      i++;
      continue;
    }

    // 多级引用块：连续的 &gt; 行一起收集后递归渲染
    if (matchBlockquote(line) !== null) {
      const quoteItems = [];
      while (i < lines.length && matchBlockquote(lines[i]) !== null) {
        quoteItems.push(matchBlockquote(lines[i]));
        i++;
      }
      htmlParts.push(renderQuoteLines(quoteItems, pool));
      continue;
    }

    // 多级嵌套列表（含任务列表）：收集所有缩进相关的连续行
    if (matchListItemWithIndent(line) !== null) {
      const listItems = [];
      while (i < lines.length && matchListItemWithIndent(lines[i]) !== null) {
        listItems.push(matchListItemWithIndent(lines[i]));
        i++;
      }
      // 找出顶层（level === 最小 level）的有序/无序类型
      const minLevel = Math.min(...listItems.map((it) => it.level));
      const topOrdered = listItems.find((it) => it.level === minLevel).ordered;
      const tag = topOrdered ? 'ol' : 'ul';
      htmlParts.push(
        '<' + tag + ' class="md-list">' + renderListItems(listItems, minLevel, pool) + '</' + tag + '>'
      );
      continue;
    }

    // 普通文本段落
    const textLines = [];
    while (i < lines.length && !startsNewBlock(lines, i)) {
      // 空行产生段落分隔
      if (lines[i].trim() === '') {
        if (textLines.length > 0) {
          htmlParts.push('<p class="md-p">' + textLines.join('<br>') + '</p>');
          textLines.length = 0;
        }
        i++;
        continue;
      }
      textLines.push(applyInline(lines[i], pool, true));
      i++;
    }
    if (textLines.length > 0) {
      htmlParts.push('<p class="md-p">' + textLines.join('<br>') + '</p>');
    }
  }

  // \u0002 是 extractBlocks() 里用来临时保护代码块/数学块内部换行符的标记，
  // 整个块级扫描流程结束、不再有"按行处理"的风险后，在这里统一换回真正的换行符。
  return pool.restore(htmlParts.join('')).replace(/\u0002/g, '\n');
}

// ─────────────────────────────────────────
// 弹幕专用：只做行内格式，不做块级结构
// ─────────────────────────────────────────
function renderInlineMarkdown(raw) {
  if (typeof raw !== 'string') return '';
  raw = raw.replace(/[\u0000\u0001\u0002]/g, '');
  const pool = createPlaceholderPool();
  let text = escapeHtml(raw.replace(/\n/g, ' '));
  text = applyInline(text, pool, false);
  return pool.restore(text);
}

// ─────────────────────────────────────────
// 导出（兼容 Node CommonJS 和浏览器全局变量两种环境）
// ─────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, renderMarkdown, renderInlineMarkdown };
}
