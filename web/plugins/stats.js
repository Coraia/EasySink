(() => {
  WR.addNav({ href: "#/stats", label: "统计" });
  WR.addRoute("/stats", renderStats);

  function stopHeartbeat() {
    if (WR._statsTimer) {
      clearInterval(WR._statsTimer);
      WR._statsTimer = null;
    }
  }

  WR.on("read", ({ id }) => {
    stopHeartbeat();
    WR._statsTimer = setInterval(() => {
      if (!location.hash.startsWith("#/read/")) {
        stopHeartbeat();
        return;
      }
      WR.api("/api/stats/heartbeat", { method: "POST", body: { doc_id: id, seconds: 15 } }).catch(() => {});
    }, 15000);
  });

  window.addEventListener("hashchange", () => {
    if (!location.hash.startsWith("#/read/")) stopHeartbeat();
  });

  async function renderStats() {
    const s = await WR.api("/api/stats");
    const h = Math.floor(s.seconds / 3600);
    const m = Math.floor((s.seconds % 3600) / 60);
    const app = document.getElementById("app");
    app.innerHTML = `
      <h2>阅读统计</h2>
      <div class="card">
        <p>累计阅读 <strong>${h} 小时 ${m} 分</strong>（心跳统计，打开阅读页才会记）</p>
        <p class="meta">文章 ${s.document_count} · 认识 ${s.known_count} · 生词 ${s.unknown_count}</p>
      </div>
      <ul class="list">
        ${s.by_document.map((d) => `<li><span>${WR.escapeHtml(d.title)}</span>
          <span class="meta">${Math.round(d.seconds / 60)} 分钟</span></li>`).join("") || "<li>还没有时长</li>"}
      </ul>`;
  }
})();
