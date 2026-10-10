import { sourceExcerpt } from "../source-selection.js";
import { $, e, api, toast, date } from "../core.js";
export function install(ctx) {
  // Writes belong to the plugin lifetime, including after a reader route closes.
  const mutations = new Set();
  let mutationFailures = 0;
  const mutate = (path, options) => {
    const promise = api(path, { ...options, keepalive: true });
    mutations.add(promise);
    promise.then(
      () => mutations.delete(promise),
      () => { mutationFailures++; mutations.delete(promise); },
    );
    return promise;
  };
  const flush = async () => {
    const failuresBefore = mutationFailures;
    while (mutations.size) await Promise.allSettled([...mutations]);
    return mutationFailures === failuresBefore;
  };
  const beforeClose = event => event.detail.waitUntil(flush());
  window.addEventListener("reader-before-close", beforeClose);
  const paint = (r) => {
    if (!r.bookmarks || r.scope.signal.aborted) return;
    document.querySelectorAll(".bookmark-marker").forEach((el) => el.remove());
    for (const b of r.bookmarks) {
      const blocks = [...document.querySelectorAll("#article [data-block]")];
      const block =
        blocks.find(
          (el) =>
            el.dataset.block === b.anchor?.block_id &&
            b.anchor.start >= +el.dataset.start &&
            b.anchor.start < +el.dataset.end,
        ) ||
        (!b.anchor?.block_id &&
          blocks[
            Math.min(
              blocks.length - 1,
              Math.floor((b.scroll_ratio || 0) * blocks.length),
            )
          ]);
      if (!block || block.querySelector(".bookmark-marker")) continue;
      if (
        b.anchor &&
        (b.anchor.start < +block.dataset.start ||
          b.anchor.start >= +block.dataset.end)
      )
        continue;
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
    const known = new Map(r.bookmarks.map(b => [b.id, b]));
    const touched = new Set(), removing = new Set();
    const documentIds = new Set([r.doc.id, ...r.doc.chapters.map(ch => ch.doc_id)]);
    let adding = false;
    const publish = () => {
      if (r.scope.signal.aborted) return;
      r.bookmarks = [...known.values()].filter(b => b.doc_id === r.doc.id);
      paint(r);
      r.emit("bookmarks-change");
    };
    const remove = async (items) => {
      items = items.filter(b => !removing.has(b.id));
      if (!items.length) return;
      for (const b of items) {
        removing.add(b.id);
        touched.add(b.id);
        known.delete(b.id);
      }
      publish();
      // DELETE is idempotent. Let an explicit mutation finish after a panel or
      // reader closes; aborting its response cannot undo a server-side delete.
      const results = await Promise.allSettled(items.map(b =>
        mutate("/bookmarks/" + b.id, { method: "DELETE" })));
      const failed = [];
      results.forEach((result, i) => {
        const b = items[i];
        removing.delete(b.id);
        if (result.status === "rejected") {
          known.set(b.id, b);
          failed.push(result.reason);
        }
      });
      publish();
      if (!r.scope.signal.aborted)
        toast(failed.length ? "书签未能移除，已恢复。" + failed[0].message : "书签已移除");
    };
    const toggle = async (anchor = r.selection || r.position()) => {
      if (adding || removing.size) return;
      const existing = [...known.values()].filter(b =>
        b.doc_id === r.doc.id && b.anchor?.block_id === anchor.block_id);
      if (existing.length) return remove(existing);
      adding = true;
      r.updateBookmark();
      try {
        const bookmark = await mutate("/bookmarks", {
          method: "POST",
          body: { doc_id: r.doc.id, label: anchor.quote?.slice(0, 55) || r.doc.title,
            scroll_ratio: anchor.ratio, anchor },
        });
        touched.add(bookmark.id);
        known.set(bookmark.id, bookmark);
        publish();
        if (!r.scope.signal.aborted) toast("已为这段文字添加书签");
      } finally {
        adding = false;
        publish();
      }
    };
    const button = r.tool("bookmarks", "书签", () => toggle());
    button.dataset.toggle = "true";
    r.selectionAction("bookmarks", "在选区加书签", anchor => toggle(anchor));
    r.updateBookmark = () => {
      const block = (r.selection || r.position()).block_id;
      const active = r.bookmarks.some(b => b.anchor?.block_id === block);
      button.disabled = adding || removing.size > 0;
      button.setAttribute("aria-pressed", String(active));
      button.textContent = active ? "已加书签" : "书签";
      button.title = active ? "移除当前段落的书签" : "为当前段落添加书签";
    };
    r.scope.on(window, "scroll", r.updateBookmark, { passive: true });
    r.on("position", r.updateBookmark);
    r.on("selection-render", r.updateBookmark);
    r.scope.on($("#article"), "click", ev => {
      const marker = ev.target.closest(".bookmark-marker");
      if (!marker) return;
      ev.stopPropagation();
      const block = marker.closest("[data-block]").dataset.block;
      void remove(r.bookmarks.filter(b =>
        b.anchor?.block_id === block || b.id === +marker.dataset.bookmark));
    });
    r.mountBookmarkList = (el, scope) => {
      const section = document.createElement("section");
      section.dataset.readerBookmarks = "";
      section.className = "gap";
      section.setAttribute("aria-label", "书签");
      section.innerHTML = '<div class="row between"><h3>书签</h3><button type="button" class="text-button" data-bookmark-current>标记当前位置</button></div><p class="meta" role="status" data-bookmark-status></p><div data-bookmark-items></div>';
      el.append(section);
      const render = () => {
        $("[data-bookmark-current]", section).disabled = adding || removing.size > 0;
        $("[data-bookmark-items]", section).innerHTML = [...known.values()]
          .sort((a, b) => b.id - a.id)
          .map(b => `<div class="list-item" data-bookmark-entry="${b.id}"><button type="button" class="toc-link" data-bm="${b.id}">${e(sourceExcerpt(b.label || b.title || r.doc.title))}</button><div class="row between"><span class="meta">${e(b.title || r.doc.title)}</span><button type="button" class="text-button" data-delete-bm="${b.id}" aria-label="删除书签">删除</button></div></div>`)
          .join("") || '<p class="muted">还没有书签。可标记当前位置，或选中原文添加书签。</p>';
      };
      scope.on(r.events, "bookmarks-change", render);
      scope.on(section, "click", ev => {
        const jump = ev.target.closest("[data-bm]");
        const del = ev.target.closest("[data-delete-bm]");
        if (jump) {
          const b = known.get(+jump.dataset.bm);
          if (!b) return;
          const anchor = b.anchor || { ratio: b.scroll_ratio };
          r.focus.close();
          if (b.doc_id === r.doc.id)
            Promise.resolve(r.restore(anchor)).catch(err => toast(err.message));
          else ctx.jump(b.doc_id, anchor);
        } else if (del) {
          const b = known.get(+del.dataset.deleteBm);
          if (b) void remove([b]);
        } else if (ev.target.closest("[data-bookmark-current]")) {
          toggle().catch(err => toast(err.message));
        }
      });
      render();
      const status = $("[data-bookmark-status]", section);
      status.textContent = "正在读取书签…";
      api("/bookmarks", { signal: scope.signal }).then(list => {
        if (scope.signal.aborted || r.scope.signal.aborted) return;
        // A late list response must not resurrect a locally removed bookmark
        // or overwrite a newer addition/rollback.
        for (const b of list)
          if (documentIds.has(b.doc_id) && !touched.has(b.id)) known.set(b.id, b);
        status.textContent = "";
        publish();
      }).catch(err => {
        if (!scope.signal.aborted) status.textContent = "其他书签暂未读到：" + err.message;
      });
    };
    paint(r);
  });
  const route = ctx.route("bookmarks", async (scope) => {
    const list = await api("/bookmarks", { signal: scope.signal });
    if (scope.signal.aborted) return;
    ctx.root.innerHTML = `<div class="page"><div class="page-head"><div><div class="eyebrow">PLACES TO RETURN TO</div><h1>还想回来的地方。</h1><p>书签跟随正文段落，改变排版也能回来。</p></div></div><div id="bookmark-list" class="card">${list.map((b) => `<div class="list-item"><span class="meta">${e(b.title)} · ${date(b.created_at)}</span><h3 class="gap">${e(sourceExcerpt(b.label))}</h3><div class="row between"><button data-bm="${b.id}" class="text-button">跳到原文 →</button><button data-delete-bm="${b.id}" class="text-button">删除</button></div></div>`).join("") || '<div class="empty">阅读时点击“书签”，记下想回来的位置。</div>'}</div></div>`;
    scope.on($("#bookmark-list"), "click", async (ev) => {
      const btn = ev.target.closest("[data-bm]");
      if (btn) {
        const b = list.find((b) => b.id === +btn.dataset.bm);
        ctx.jump(b.doc_id, b.anchor || { ratio: b.scroll_ratio });
      }
      const del = ev.target.closest("[data-delete-bm]");
      if (del) {
        if (del.disabled) return;
        del.disabled = true;
        const item = del.closest(".list-item");
        item.hidden = true;
        try {
          await mutate("/bookmarks/" + del.dataset.deleteBm, { method: "DELETE" });
          item.remove();
          if (!scope.signal.aborted) toast("书签已删除");
        } catch (err) {
          if (!scope.signal.aborted) {
            item.hidden = false;
            del.disabled = false;
            toast("书签未能移除，已恢复。" + err.message);
          }
        }
      }
    });
  });
  return () => {
    // Disabling the plugin must not hide already-issued writes from native quit.
    void flush().then(() => {
      window.removeEventListener("reader-before-close", beforeClose);
    });
    read();
    draw();
    route();
  };
}
