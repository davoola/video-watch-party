// 从服务器读取 .env 里配置的 SITE_NAME，应用到当前页面的标题和品牌文字上。
// 四个页面（登录/视频库/聊天/播放）都引入这同一个脚本，靠 <body data-title-prefix="..."> 
// 区分各自标题前缀；不需要更新品牌文字的页面（chat.html/player.html）只是没有
// [data-site-name] 元素，下面的 forEach 自然什么都不做。
(function () {
  async function applySiteName() {
    let siteName = '私密影院'; // 请求失败或还没返回时的兜底默认值，和原来硬编码的文案保持一致

    try {
      const res = await fetch('/api/site-config');
      if (res.ok) {
        const data = await res.json();
        if (data && data.siteName) {
          siteName = data.siteName;
        }
      }
    } catch {
      // 静默失败即可：拿不到自定义站点名不应该影响页面正常使用，用兜底默认值继续
    }

    const prefix = document.body.dataset.titlePrefix || '';
    document.title = prefix ? `${prefix} - ${siteName}` : siteName;

    document.querySelectorAll('[data-site-name]').forEach((el) => {
      el.textContent = siteName;
    });
  }

  applySiteName();
})();
