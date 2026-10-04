import { $, e, api, toast, date } from "../core.js";
export function install(ctx) {
  const paint = (r) => {
    if (!r.bookmarks || r.scope.signal.aborted) return;
    document.querySelectorAll(".bookmark-marker").forEach((el) => el.remove());
    for (const b of r.bookmarks) {
      const blocks = [...document.querySelectorAll("#article [data-block]")];
      const block =
        blocks.find((el) => el.dataset.block === b.anchor?.block_id) ||
        blocks[
          Math.min(
            blocks.length - 1,
            Math.floor((b.scroll_ratio || 0) * blocks.length),
          )
        ];
      if (!block || block.querySelector(".bookmark-marker")) continue;
      const btn = document.createElement("button");
      btn.className = "bookmark-marker";
      btn.dataset.bookmark = b.id;
      btn.setAttribute("aria-label", "移除书签");
      btn.title = "已加书签 · 点击移除";
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
      block.prepend(btn);
    }
    r.updateBookmark?.();
  };
  const draw = ctx.hook("draw", paint);
  const read = ctx.hook("read", async (r) => {
    r.bookmarks = await api("/bookmarks?doc_id=" + r.doc.id, {
      signal: r.scope.signal,
    });
    if (r.scope.signal.aborted) return;
    const button = r.tool("bookmarks", "书签", async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        const anchor = r.position();
        const result = await api("/bookmarks/toggle", {
          method: "POST",
          body: {
            doc_id: r.doc.id,
            label: anchor.quote?.slice(0, 55) || r.doc.title,
            scroll_ratio: anchor.ratio,
            anchor,
          },
          signal: r.scope.signal,
        });
        if (r.scope.signal.aborted) return;
        r.bookmarks = result.bookmarks;
        paint(r);
        toast(result.active ? "已为这段文字添加书签" : "已移除这段文字的书签");
      } finally {
        button.disabled = false;
      }
    });
    button.dataset.toggle = "true";
    r.updateBookmark = () => {
      const block = r.position().block_id;
      const active = r.bookmarks.some((b) => b.anchor?.block_id === block);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = active ? "已加书签" : "书签";
      button.title = active ? "移除当前段落的书签" : "为当前段落添加书签";
    };
    r.scope.on(window, "scroll", r.updateBookmark, { passive: true });
    r.scope.on($("#article"), "click", async (ev) => {
      const marker = ev.target.closest(".bookmark-marker");
      if (!marker || marker.disabled) return;
      ev.stopPropagation();
      marker.disabled = true;
      try {
        const block = marker.closest("[data-block]").dataset.block;
        for (const b of r.bookmarks.filter(
          (b) =>
            b.anchor?.block_id === block || b.id === +marker.dataset.bookmark,
        ))
          await api("/bookmarks/" + b.id, {
            method: "DELETE",
            signal: r.scope.signal,
          });
        r.bookmarks = await api("/bookmarks?doc_id=" + r.doc.id, {
          signal: r.scope.signal,
        });
        paint(r);
        toast("书签已移除");
      } catch (err) {
        if (err.name !== "AbortError") toast(err.message);
        marker.disabled = false;
      }
    });
    paint(r);
  });
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
    draw();
    route();
  };
}
