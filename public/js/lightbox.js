// 通用 Lightbox 组件：全屏查看图片，支持左右/上下键切换、Esc 关闭、点击空白处关闭。
// index.html（图片库）、chat.html（独立聊天室图片）、player.html（播放页聊天面板图片）
// 三个页面共用这一份逻辑，页面里只需要放一份固定结构的 HTML（id 保持一致）：
//   <div class="lightbox" id="lightbox" hidden>
//     <button class="lightbox-close" id="lightboxClose">✕</button>
//     <button class="lightbox-nav lightbox-prev" id="lightboxPrev">‹</button>
//     <img class="lightbox-image" id="lightboxImage" alt="">
//     <button class="lightbox-nav lightbox-next" id="lightboxNext">›</button>
//     <div class="lightbox-caption" id="lightboxCaption"></div>
//   </div>
// 然后引入这个脚本，就可以用：
//   Lightbox.open(items, startIndex)   items: [{ url, caption }, ...]，多图带"上一张/下一张"
//   Lightbox.openSingle(url, caption)  只有一张图时的简化调用（比如单条聊天图片），
//                                      会自动隐藏"上一张/下一张"按钮
(function () {
  const lightboxEl = document.getElementById('lightbox');
  if (!lightboxEl) return; // 页面没有放 lightbox 结构（理论上不会发生），静默跳过，不报错

  const imageEl = document.getElementById('lightboxImage');
  const captionEl = document.getElementById('lightboxCaption');
  const closeBtn = document.getElementById('lightboxClose');
  const prevBtn = document.getElementById('lightboxPrev');
  const nextBtn = document.getElementById('lightboxNext');

  let items = [];
  let index = -1;

  function showCurrent() {
    const item = items[index];
    if (!item) return;
    imageEl.src = item.url;
    imageEl.alt = item.caption || '';
    const multi = items.length > 1;
    captionEl.textContent = multi
      ? `${item.caption || ''} (${index + 1} / ${items.length})`
      : (item.caption || '');
    // 只有一张图时（比如单条聊天图片），没有"上一张/下一张"可翻，把按钮隐藏掉
    prevBtn.style.display = multi ? '' : 'none';
    nextBtn.style.display = multi ? '' : 'none';
  }

  function open(newItems, startIndex) {
    if (!newItems || !newItems.length) return;
    items = newItems;
    index = startIndex || 0;
    showCurrent();
    lightboxEl.hidden = false;
    document.body.style.overflow = 'hidden'; // 打开大图时禁止背后的页面滚动
  }

  function openSingle(url, caption) {
    open([{ url, caption: caption || '' }], 0);
  }

  function close() {
    lightboxEl.hidden = true;
    items = [];
    index = -1;
    imageEl.src = '';
    document.body.style.overflow = '';
  }

  function prev() {
    if (index < 0 || items.length < 2) return;
    index = (index - 1 + items.length) % items.length;
    showCurrent();
  }

  function next() {
    if (index < 0 || items.length < 2) return;
    index = (index + 1) % items.length;
    showCurrent();
  }

  closeBtn.addEventListener('click', close);
  prevBtn.addEventListener('click', prev);
  nextBtn.addEventListener('click', next);

  // 点击遮罩空白处（不是图片/按钮本身）也关闭 lightbox
  lightboxEl.addEventListener('click', (e) => {
    if (e.target === lightboxEl) close();
  });

  // 键盘导航：左/上一张，右/下一张，Esc 关闭；只有 lightbox 打开时才响应，
  // 避免影响页面其它按键操作（比如聊天输入框打字）
  document.addEventListener('keydown', (e) => {
    if (lightboxEl.hidden) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      prev();
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      next();
    } else if (e.key === 'Escape') {
      close();
    }
  });

  window.Lightbox = { open, openSingle, close };
})();
