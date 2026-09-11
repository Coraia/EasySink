/* 插件宿主：按开关加载 web/plugins/<id>.js，再启动路由。 */
(async function bootPlugins() {
  function loadScript(src) {
    return new Promise((resolve) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => resolve();
      document.body.appendChild(s);
    });
  }
  try {
    const data = await WR.api("/api/plugins");
    WR.flags = {};
    for (const p of data.plugins) WR.flags[p.id] = p.enabled;
    for (const p of data.plugins) {
      if (!p.enabled) continue;
      await loadScript(`/static/plugins/${p.id}.js`);
    }
    const nav = document.getElementById("plugin-nav");
    if (nav) {
      nav.innerHTML = WR.hooks.nav
        .map((n) => `<a href="${WR.escapeHtml(n.href)}">${WR.escapeHtml(n.label)}</a>`)
        .join("");
    }
  } catch (err) {
    console.warn("plugin boot", err);
  }
  WR.route();
})();
