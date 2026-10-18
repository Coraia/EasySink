import { $, e, api } from "../core.js";
export function install(ctx) {
  const read = ctx.hook("read", (r) => {
    let elapsed = 0,
      last = performance.now(),
      activeAt = Date.now();
    const s = r.scope;
    const activity = () => {
      activeAt = Date.now();
    };
    s.on(window, "pointerdown", activity);
    s.on(window, "keydown", activity);
    s.on(window, "scroll", activity, { passive: true });
    const sample = () => {
      const now = performance.now();
      if (!document.hidden && Date.now() - activeAt < 120000)
        elapsed += Math.min(2, (now - last) / 1000);
      last = now;
    };
    const flush = () => {
      sample();
      const seconds = Math.min(120, Math.floor(elapsed));
      if (seconds < 1) return;
      elapsed -= seconds;
      api("/stats/heartbeat", {
        method: "POST",
        body: { doc_id: r.doc.id, seconds },
        keepalive: true,
      }).catch(() => {});
    };
    s.interval(sample, 1000);
    s.interval(flush, 15000);
    s.on(document, "visibilitychange", () => {
      flush();
      last = performance.now();
    });
    s.cleanup(flush);
    s.on(window, "pagehide", flush);
  });
  const route = ctx.route("stats", async (scope) => {
    const [stats, logs] = await Promise.all([
      api("/stats", { signal: scope.signal }),
      api("/reading-log", { signal: scope.signal }),
    ]);
    if (scope.signal.aborted) return;
    ctx.root.innerHTML = `<div class="page"><div class="page-head"><div><div class="eyebrow">LITTLE BY LITTLE</div><h1>每一页，都算数。</h1><p>统计可见页面的活跃阅读时间；连续静止超过两分钟会暂停计时。</p></div></div><div class="stats-grid"><div class="card stat">${Math.floor(stats.seconds / 60)}<small>累计阅读分钟</small></div><div class="card stat">${stats.known_count}<small>已掌握的词</small></div><div class="card stat">${new Set(logs.map((l) => l.doc_id)).size}<small>标记读完的篇数</small></div></div><section class="card"><h2>阅读过的时间</h2>${stats.by_document.map((d) => `<div class="list-item row between"><span>${e(d.title)}</span><span class="meta">${Math.ceil(d.seconds / 60)} 分钟</span></div>`).join("") || '<div class="empty">从第一篇开始，慢慢积累。</div>'}</section></div>`;
  });
  return () => {
    read();
    route();
  };
}
