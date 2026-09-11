import { $, e, api, toast, date } from "../core.js";
export function install(ctx) {
  const read = ctx.hook("read", (r) =>
    r.tool("bookmarks", "书签", async () => {
      const anchor = r.position();
      await api("/bookmarks", {
        method: "POST",
        body: {
          doc_id: r.doc.id,
          label: anchor.quote?.slice(0, 55) || r.doc.title,
          scroll_ratio: anchor.ratio,
          anchor,
        },
      });
      toast("已为这段文字添加书签");
    }),
  );
  const route = ctx.route("bookmarks", async (scope) => {
    const list = await api("/bookmarks", { signal: scope.signal });
    if (scope.signal.aborted) return;
    ctx.root.innerHTML = `<div class="page"><div class="page-head"><div><div class="eyebrow">PLACES TO RETURN TO</div><h1>还想回来的地方。</h1><p>书签跟随正文段落，改变排版也能回来。</p></div></div><div id="bookmark-list" class="card">${list.map((b) => `<div class="list-item"><span class="meta">${e(b.title)} · ${date(b.created_at)}</span><h3 class="gap">${e(b.label)}</h3><div class="row between"><button data-bm="${b.id}" class="text-button">跳到原文 →</button><button data-delete-bm="${b.id}" class="text-button">删除</button></div></div>`).join("") || '<div class="empty">阅读时点击“书签”，记下想回来的位置。</div>'}</div></div>`;
    scope.on($("#bookmark-list"), "click", async (ev) => {
      const btn = ev.target.closest("[data-bm]");
      if (btn) {
        const b = list.find((b) => b.id === +btn.dataset.bm);
        ctx.jump(b.doc_id, b.anchor || { ratio: b.scroll_ratio });
      }
      const del = ev.target.closest("[data-delete-bm]");
      if (del) {
        del.disabled = true;
        try {
          await api("/bookmarks/" + del.dataset.deleteBm, { method: "DELETE" });
          del.closest(".list-item").remove();
          toast("书签已删除");
        } catch (err) {
          toast(err.message);
          del.disabled = false;
        }
      }
    });
  });
  return () => {
    read();
    route();
  };
}
