import { $, api, local, e, date } from "../core.js";
export function install(ctx) {
  const home = ctx.hook("home", async (view) => {
    const { scope } = view;
    const list = await api("/progress", { signal: scope.signal });
    if (scope.signal.aborted) return;
    const ownDocuments = new Set(view.documents.map(doc => doc.id));
    const p = list.find(position => ownDocuments.has(position.doc_id));
    if (!p) return;
    const book = view.collections?.find((book) =>
      book.chapters?.some((chapter) => chapter.doc_id === p.doc_id),
    );
    const chapter = book?.chapters.find((chapter) => chapter.doc_id === p.doc_id);
    const pdf = book?.source === "pdf" || Boolean(book?.pdf);
    $("#home-continue").innerHTML =
      `<div class="card row between wrap"><div><div class="eyebrow" style="margin-bottom:5px">接着上次的好奇心</div><h3 style="margin:0">${e(book?.title || p.title)}</h3>${chapter ? `<div class="meta">${pdf ? "阅读范围" : "第 " + (chapter.idx + 1) + " 章"} · ${e(p.title)}</div>` : ""}<span class="meta">${chapter && !pdf ? "本章 " : ""}${Math.round(p.scroll_ratio * 100)}% · ${date(p.updated_at)}</span></div><button id="continue-reading" class="primary">继续阅读 →</button></div>`;
    scope.on($("#continue-reading"), "click", () =>
      ctx.jump(p.doc_id, { ...(p.anchor || { ratio: p.scroll_ratio }), resume_position: true }),
    );
  });
  const read = ctx.hook("read", async (reader) => {
    const id = reader.doc.id,
      scope = reader.scope;
    let timer = null,
      last = null,
      confirmed = null,
      queue = Promise.resolve();
    const capturePosition = () => {
      const pages = reader.pages, word = pages?.wordReflow;
      // A navigation target may be inside the visible spread. Resume must use
      // its first source, sampled only after the actual layout has settled.
      if (!reader.restoring && !document.hidden && !reader.popElement &&
          !scope.signal.aborted && pages?.complete && pages.layoutComplete &&
          Number.isInteger(pages.layoutEpoch) && pages.stableEpoch === pages.layoutEpoch &&
          !pages.displayPending && !pages.animating && !pages.canonicalDirty &&
          !pages.retainedLayoutPending && !reader.annotationRefreshPending &&
          !word?.pendingLayout && !word?.flushing && !word?.pendingCanonical &&
          !["preparing", "playing"].includes(word?.owner?.dataset.reflowPhase)) {
        const view = reader.captureView(), anchor = view.visibleAnchor;
        const offset = pages.offsets?.get(anchor?.block_id);
        if (view.documentId === id && view.sourceVersion === reader.doc.version &&
            view.layoutEpoch === pages.layoutEpoch && anchor?.version === reader.doc.version &&
            Number.isInteger(anchor.start) && anchor.start >= 0 &&
            Number.isFinite(offset) && Number.isFinite(pages.length))
          confirmed = {...anchor, ratio: Math.min(1,
            (offset + anchor.start) / Math.max(1, pages.length))};
      }
      // Never substitute a lookup/selection target when the paper is obscured
      // or being redrawn. Keep the last confirmed source in this revision.
      return confirmed?.version === reader.doc.version ? confirmed : null;
    };
    const save = () => {
      if (!last) return queue;
      const anchor = last;
      last = null;
      queue = queue
        .catch(() => {})
        .then(() =>
          api(`/documents/${id}/progress`, {
            method: "PUT",
            body: { scroll_ratio: anchor.ratio, anchor },
            keepalive: true,
          }),
        )
        .then(() => {
          local.remove(`position-pending:${id}`);
          if (!scope.signal.aborted)
            $("#reader-save").textContent = "阅读位置已自动保存";
        })
        .catch(() => {
          local.set(`position-pending:${id}`, anchor);
          if (!scope.signal.aborted)
            $("#reader-save").textContent = "位置暂存于浏览器，连接恢复后重试";
        });
      return queue;
    };
    const saved = await api(`/documents/${id}/progress`, {
      signal: scope.signal,
    });
    if (scope.signal.aborted) return;
    const pending = local.get(`position-pending:${id}`);
    if (!local.get(`jump:${id}`))
      await reader.restore(
        pending || saved.anchor || { ratio: saved.scroll_ratio },
        { automatic: true, mark: false, alignStart: true },
      );
    const changed = () => {
      const anchor = capturePosition();
      if (!anchor) return;
      last = anchor;
      clearTimeout(timer);
      timer = setTimeout(save, 650);
    };
    reader.on("position", changed);
    scope.on(
      window,
      "scroll",
      changed,
      { passive: true },
    );
    scope.on(window, "pagehide", () => {
      if (last) local.set(`position-pending:${id}`, last);
      save();
    });
    scope.on(window, "reader-before-close", event => {
      last = capturePosition() || last;
      clearTimeout(timer);
      if (last) local.set(`position-pending:${id}`, last);
      event.detail.waitUntil(save().then(() => !local.get(`position-pending:${id}`)));
    });
    scope.on(window, "online", () => {
      last = local.get(`position-pending:${id}`);
      save();
    });
    scope.cleanup(() => {
      clearTimeout(timer);
      save();
    });
    if (pending) {
      last = pending;
      save();
    }
  });
  return () => {
    home();
    read();
  };
}
