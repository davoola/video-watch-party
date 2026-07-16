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
  // _text_ 比 *text* 更容易误触发：聊天里提到文件名（user_name_field）、变量名
  // （some_file_path）、日期（2024_01_15）都会用连续下划线，如果不加边界限制，
  // 会被整段拆开、插入一堆无意义的 <em> 标签，排版看起来"莫名其妙坏掉"且用户
  // 无法理解原因。这里参照 CommonMark 的"边界字符"规则：下划线只有紧邻非字母
  // 数字（含中文）字符时才会被当成斜体标记；不用 JS 的向后查找断言（lookbehind）
  // 是为了兼容更老的浏览器引擎（老版本 iOS Safari 不支持 lookbehind），改成把
  // 前置边界字符纳入捕获组、再用 $1 原样放回去。
  // 边界字符集覆盖 CJK 统一表意文字（中文）+ 日文平假名/片假名 + 韩文谚文，
  // 不然日语"変数_名_です"、韩语"가나_다라_마바"这类写法里的下划线仍然会被误判成斜体
  // （用户名/文件名场景在日语、韩语里同样常见，比如日文变量名喜欢用下划线分词）。
  text = text.replace(/(^|[^a-zA-Z0-9\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7a3])_([^_\n]+)_(?![a-zA-Z0-9\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7a3])/g, '$1<em>$2</em>');

  // 删除线 ~~text~~
  text = text.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 自动链接（裸 URL）：因为链接/图片已替换成占位符，这里不会二次处理
  //
  // 原来 [^\s<]+ 只排除空格和 <，中文标点/文字不是空格，会被一起吞进 URL 里——
  // 现实中"看这个链接 https://x.com，然后继续"这种写法很常见（URL 和后面的中文
  // 之间往往不会特意留空格），结果就是生成一个 href 里带着整句中文的坏链接，
  // 点击后 404。分两步修：
  // 1. 贪婪匹配阶段就把 CJK 文字和 CJK 标点排除在外（这个场景下 URL 本身几乎不会
  //    真的包含原始中文字符），从源头避免"URL 后面紧跟中文、中间没空格"被整段吞掉；
  //    排除范围同样覆盖日文平假名/片假名、韩文谚文，不然"https://x.comアクセス"
  //    这类日语场景还是会把假名吞进链接里；
  // 2. 匹配到的结果再 trim 一次末尾的 ASCII 标点（处理 "https://x.com." 
  //    "(https://x.com)" 这类西文标点紧贴在后面的情况），trim 掉的部分当普通文本
  //    放在链接外面，不影响链接本身的可点击性。
  text = text.replace(
    /(https?:\/\/[^\s<\u3000-\u303f\uff00-\uffef\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7a3]+)/g,
    (match) => {
      const trailingMatch = match.match(/[,.!?;:)\]}'"]+$/);
      const trailing = trailingMatch ? trailingMatch[0] : '';
      const url = trailing ? match.slice(0, match.length - trailing.length) : match;
      if (!url) return match; // 理论上不会发生（整段全是标点），兜底不处理
      return save('<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>') + trailing;
    }
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
 * 检测一行的缩进级别和列表类型，返回 null 表示不是列表行。
 *
 * 缩进换算成级别时特意做得宽松：不同编辑器的默认缩进不一样（VS Code/Typora/Obsidian
 * 大多用 4 个空格，但也有不少内容习惯用 2 个空格），严格按固定值整除很容易把标准的
 * 4 空格缩进误判成两级（Math.floor(4/2)=2）。这里改成"四舍五入到最近的 4 空格"，
 * 同时保证只要缩进不是 0，至少算作 1 级——2/3/4/5 个空格都算第 1 级，6/7/8/9 个
 * 空格算第 2 级，以此类推，2 空格和 4 空格两种习惯都能被合理识别。
 */
function matchListItemWithIndent(line) {
  const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (!m) return null;
  const indent = m[1];
  const level = indent.includes('\t')
    ? indent.split('').filter((c) => c === '\t').length
    : (indent.length === 0 ? 0 : Math.max(1, Math.round(indent.length / 4)));
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
 * @param {boolean} loose - 是否是"松散列表"（列表项之间有空行分隔），松散列表每一项的内容
 *   要包一层 <p>（和标准 Markdown/Editor.md 行为一致），紧凑列表则不用
 */
function renderListItems(items, depth, pool, loose) {
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
    const wrappedContent = loose ? '<p class="md-p">' + contentHtml + '</p>' : contentHtml;
    let liHtml = '';
    if (item.task) {
      liHtml = '<li class="md-task"><input type="checkbox" disabled' +
        (item.checked ? ' checked' : '') + '> ' + wrappedContent;
    } else {
      liHtml = '<li>' + wrappedContent;
    }

    if (children.length > 0) {
      liHtml += renderNestedList(children, depth + 1, pool, loose);
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
function renderNestedList(items, depth, pool, loose) {
  if (items.length === 0) return '';
  // 以第一个 item 的 ordered 属性决定标签
  const topItems = items.filter((it) => it.level === depth);
  if (topItems.length === 0) return '';
  const tag = topItems[0].ordered ? 'ol' : 'ul';
  return '<' + tag + ' class="md-list">' + renderListItems(items, depth, pool, loose) + '</' + tag + '>';
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
    // 外面包一层 .md-code-block-wrap + 复制按钮：按钮本身不知道代码内容是什么，
    // 点击时由页面里委托的 click 监听器去读取同一个 wrapper 下 <code> 的 textContent
    // 来复制——CSP 里 script-src 'self' 禁止内联事件处理器（onclick=...），所以不能
    // 直接把复制逻辑写在这里生成的 HTML 属性上，只能靠外部事件委托来接管点击。
    blocks.set(
      token,
      '<div class="md-code-block-wrap">' +
        '<button type="button" class="md-copy-btn" aria-label="复制代码">复制</button>' +
        '<pre class="md-code-block"><code' + langAttr + '>' + escaped + '</code></pre>' +
      '</div>'
    );
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
  // 已经生成好的代码块/数学块 HTML（可能是 <pre class="..."> 或者代码块外层新加的
  // .md-code-block-wrap 容器）：这个检查必须放在最前面。之前这里漏掉了这一条，
  // 导致"普通文本段落"的收集循环会把紧跟在文字后面的代码块整个吞进 <p> 标签里
  // （破坏 DOM 结构，代码内容还会被 applyInline 的行内规则误处理，比如代码里的
  // 星号被当成加粗语法）。
  if (/<pre\s/.test(line) || line.startsWith('<pre>') || line.startsWith('<div class="md-code-block-wrap">')) return true;
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.trim())) return true;   // HR
  if (/^#{1,6}(?:\s|$)/.test(line)) return true;                       // 标题（含没有标题文字的空标题）
  if (/^(?:&gt;\s?)+/.test(line)) return true;                        // 引用（已转义）
  if (/^\s*([-*+]|\d+\.)\s/.test(line)) return true;                   // 列表
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

  // 安全熔断：这个手写解析器的每个循环理论上都是线性推进、必然终止的（已经用远超
  // 实际场景大小的输入做过压测），但为了不把"万一某种输入组合触发了未预料到的
  // 极端耗时路径"这种可能性完全押注在"理论上不会发生"上，这里加一个硬性时间上限
  // 兜底：一旦真的超时，就把剩余内容原样转义成纯文本段落输出（退化成"看起来没格式"，
  // 但绝不会让整个页面失去响应）。
  // 20 秒对正常文档（哪怕是 2MB 上限）在任何设备上都绰绰有余——这里刻意给得宽松，
  // 是因为之前设的 3 秒在低端安卓手机/平板上跑较长文档时会被真实触发（单线程 CPU
  // 较弱 + 每行多次正则替换，桌面端毫秒级的操作换到弱 CPU 上可能要慢 5-10 倍），
  // 相当于"防死循环"的安全网误伤了"设备性能差但内容完全正常"的情况。
  const deadline = Date.now() + 20000;

  while (i < lines.length) {
    if (Date.now() > deadline) {
      htmlParts.push('<p class="md-p">' + escapeHtml('（内容解析超时，剩余部分未渲染，请下载查看完整内容）') + '</p>');
      break;
    }

    const line = lines[i];

    // 已经处理好的代码块/数学块 HTML 直接输出（可能一行就是整个 <pre>...</pre>，
    // 代码块外面现在多包了一层 .md-code-block-wrap，一并识别）
    if (/<pre\s/.test(line) || line.startsWith('<pre>') || line.startsWith('<div class="md-code-block-wrap">')) {
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

    // 标题（允许空标题，比如 "### " 后面没有标题文字——CommonMark 本身也允许这种写法；
    // 这里的正则必须和 startsNewBlock() 里判断"是不是标题"的正则保持一致，否则一行
    // 内容会出现"两边判断不一致"的情况：分发逻辑这里说"不是标题"，掉进下面的
    // "普通文本段落"分支，但那个分支用来判断"该不该停止"的 startsNewBlock() 却说
    // "是标题，应该停"——两边掐架的结果是 i 完全不会前进，外层 while 循环原地
    // 死循环，只能靠最上面的超时熔断硬生生打断，表现出来就是"很简单的文档也会卡死"。
    const hMatch = line.match(/^(#{1,6})(?:\s+(.*))?$/);
    if (hMatch) {
      const tag = 'h' + hMatch[1].length;
      const headingContent = hMatch[2] || '';
      htmlParts.push('<' + tag + ' class="md-heading">' + applyInline(headingContent, pool, true) + '</' + tag + '>');
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
      let loose = false;

      while (i < lines.length) {
        const cur = lines[i];
        const matched = matchListItemWithIndent(cur);
        if (matched !== null) {
          listItems.push(matched);
          i++;
          continue;
        }
        if (cur.trim() === '') {
          // 标准 Markdown 允许列表项之间用空行分隔（"松散列表"），空行本身不代表
          // 列表结束——往后跳过连续空行看一眼，如果紧接着还是列表项，说明只是
          // 分隔符，继续收集（并把这个列表标记为"松散"，渲染时每项内容包一层 <p>）；
          // 如果空行后面不是列表项（或者已经到文档末尾），列表才是真的结束了，
          // 把 i 留在这一行空行上，交还给外层循环按普通逻辑处理。
          let lookahead = i;
          while (lookahead < lines.length && lines[lookahead].trim() === '') lookahead++;
          if (lookahead < lines.length && matchListItemWithIndent(lines[lookahead]) !== null) {
            loose = true;
            i = lookahead;
            continue;
          }
          break;
        }
        break; // 遇到非空、非列表行（标题/引用/代码块等），列表结束
      }

      // 找出顶层（level === 最小 level）的有序/无序类型
      const minLevel = Math.min(...listItems.map((it) => it.level));
      const topOrdered = listItems.find((it) => it.level === minLevel).ordered;
      const tag = topOrdered ? 'ol' : 'ul';
      htmlParts.push(
        '<' + tag + ' class="md-list">' + renderListItems(listItems, minLevel, pool, loose) + '</' + tag + '>'
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
