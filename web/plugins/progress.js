(() => {
  WR.on("home", async ({ root }) => {
    if (!root) return;
    try {
      const rows = await WR.api("/api/progress");
      if (!rows.length) return;
      const last = rows[0];
      root.insertAdjacentHTML("afterbegin", `
        <section class="card">
          <h3>继续阅读</h3>
          <p><a href="#/read/${last.doc_id}">${WR.escapeHtml(last.title)}</a>
            <span class="meta">约 ${Math.round(last.scroll_ratio * 100)}%</span></p>
        </section>`);
    } catch (e) { /* ignore */ }
  });

  WR.on("read", async ({ id }) => {
    const q = new URLSearchParams((location.hash.split("?")[1] || ""));
    const pin = q.has("at") ? Math.min(1, Math.max(0, +q.get("at") || 0)) : null;
    try {
      const ratio = pin != null ? pin : (await WR.api(`/api/documents/${id}/progress`)).scroll_ratio;
      if (ratio > 0.02) WR.restoreScroll(ratio);
    } catch (e) { /* ignore */ }
    let t;
    const save = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const el = document.scrollingElement || document.documentElement;
        const max = el.scrollHeight - window.innerHeight;
        const ratio = max > 0 ? el.scrollTop / max : 0;
        WR.api(`/api/documents/${id}/progress`, {
          method: "PUT",
          body: { scroll_ratio: ratio },
        }).catch(() => {});
      }, 400);
    };
    if (WR._progressAc) WR._progressAc.abort();
    WR._progressAc = new AbortController();
    window.addEventListener("scroll", save, { passive: true, signal: WR._progressAc.signal });
  });
})();
