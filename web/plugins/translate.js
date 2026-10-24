import { anchorSegments, combineSelection, linkedRanges, sameSelection } from "../source-selection.js";
import { actionIcon } from "../reading-action-icons.js";
import { $, $$, e } from "../core.js";

export function install(ctx) {
  return ctx.hook("read", (r) => {
    let result = null,
      locked = null,
      navigation = 0,
      target = null,
      locateController = null,
      hoverTimer = 0,
      openGeneration = 0,
      openRequest = null;
    const pane = $("#translation-pane");
    const cancelNavigation = () => {
      ++navigation;
      target = null;
      clearTimeout(hoverTimer);
      hoverTimer = 0;
      locateController?.abort();
      locateController = null;
    };
    const cancelOpen = () => {
      ++openGeneration;
      if (openRequest && r.pending.get("translation") === openRequest) {
        openRequest.cancel();
        r.pending.delete("translation");
        if (!r.scope.signal.aborted) {
          r.renderSelection();
          r.emit("assist-change");
        }
      }
      openRequest = null;
    };
    r.scope.cleanup(() => { cancelNavigation(); cancelOpen(); });
    const pdfMatches = (part, canonical, required = false) => {
      const source = part.pdf_source;
      if (!source) return !required;
      if (!canonical.pdf_source) return false;
      return Object.entries(canonical.pdf_source).every(([key, value]) =>
        value == null || JSON.stringify(source[key]) === JSON.stringify(value));
    };
    const canonicalSelection = (anchor) => {
      if (!anchor || anchor.version !== r.doc.version || !r.sourceParts(anchor)) return null;
      const source = anchorSegments(anchor), parts = [];
      let previous = -1;
      for (const part of source) {
        const index = r.doc.blocks.findIndex(block => block.id === part.block_id);
        if (index <= previous || part.end <= part.start) return null;
        const canonical = r.anchorFor(part.block_id, part.start, part.end);
        if (!canonical || canonical.kind === "image" || part.quote !== canonical.quote ||
            !pdfMatches(part, canonical, Boolean(r.doc.pdf))) return null;
        parts.push(canonical);
        previous = index;
      }
      return parts.length && parts.map(part => part.quote).join("\n\n") === anchor.quote
        ? combineSelection(parts) : null;
    };
    const currentResult = () => result &&
      (result.doc_id == null || String(result.doc_id) === String(r.doc.id)) &&
      Array.isArray(result.payload?.segments) && canonicalSelection(result.anchor);
    const begin = (kind, hidden = false) => {
      cancelNavigation();
      const controller = new AbortController();
      locateController = controller;
      const request = {kind, value: result, token: navigation, controller, hidden,
        documentId: r.doc.id, version: r.doc.version, epoch: null};
      request.current = () => target === request && request.token === navigation &&
        request.value === result && pane.hidden === hidden &&
        request.documentId === r.doc.id && request.version === r.doc.version &&
        !controller.signal.aborted && !r.scope.signal.aborted;
      target = request;
      return request;
    };
    const stable = async (request) => {
      // A resize can invalidate geometry before its deferred reflow begins.
      // Retire that wait, while the same latest source intent follows reflow.
      while (request.current()) {
        const epoch = request.epoch = r.pages.layoutEpoch;
        const waiter = new AbortController();
        const abort = () => waiter.abort();
        request.controller.signal.addEventListener("abort", abort, {once: true});
        let settled;
        try {
          if (request.controller.signal.aborted) waiter.abort();
          settled = await r.pages.whenStable({epoch, signal: waiter.signal});
        } finally {
          request.controller.signal.removeEventListener("abort", abort);
          waiter.abort();
        }
        if (!request.current()) return false;
        if (epoch !== r.pages.layoutEpoch) continue;
        return settled;
      }
      return false;
    };
    const finish = (request) => {
      if (target !== request) return;
      target = null;
      if (locateController === request.controller) locateController = null;
    };
    const closeControl = document.createElement("button");
    closeControl.type = "button";
    closeControl.dataset.closeTranslation = "";
    closeControl.setAttribute("aria-label", "收起对照译文");
    closeControl.title = "收起对照译文";
    closeControl.innerHTML = actionIcon("close");
    const syncCloseControl = () => {
      closeControl.hidden = pane.hidden;
      // Opening reader tools makes the reading stage inert. Its close control
      // must join that active surface rather than sit above an inert ancestor.
      const inChrome = !pane.hidden && !$("#reader-chrome").hidden;
      closeControl.classList.toggle("reader-icon", inChrome);
      const parent = inChrome
        ? $(".reading-banner")
        : $(".translation-heading", pane);
      if (parent && closeControl.parentElement !== parent) parent.append(closeControl);
    };
    const chromeObserver = new MutationObserver(syncCloseControl);
    chromeObserver.observe($(".reader"), { attributes: true, attributeFilter: ["data-chrome"] });
    r.scope.cleanup(() => { chromeObserver.disconnect(); closeControl.remove(); });
    const paint = () => {
      if (!result) return;
      pane.hidden = false;
      $(".reading-columns").classList.add("has-translation");
      pane.innerHTML = `<div class="translation-heading"><h2>所选文字 · 对照</h2></div><div class="meta">${e(result.source)}</div><div class="translation-segments">${result.payload.segments.map((v, i) => `<button type="button" class="translation-segment" data-pair="${i}" aria-label="定位对应原文：${e(v.zh)}">${e(v.zh)}</button>`).join("")}</div><div class="translation-actions"><button type="button" data-return-translation>回到选区</button>${ctx.enabled("notes") ? '<button type="button" data-translation-note>记一笔</button>' : ""}</div>`;
      syncCloseControl();
    };
    const preserveView = async (request, anchor, landing) => {
      try {
        await landing;
        if (!await stable(request)) return;
        if (anchor && !r.isAnchorVisible(anchor)) {
          const restored = await r.restore(anchor, {mark: false, signal: request.controller.signal});
          if (!restored || !await stable(request)) return;
        }
        if (request.current() && (!anchor || r.isAnchorVisible(anchor))) {
          r.paintSelection();
          r.positionSelection();
          if (!request.hidden) r.status("对照译文已就位。");
        }
      } catch (error) {
        if (request.current() && error.name !== "AbortError")
          r.status("原文排版暂未就绪，请稍后重试。", {notice: true});
      } finally { finish(request); }
    };
    r.showTranslation = (value) => {
      cancelOpen();
      if ((value?.doc_id != null && String(value.doc_id) !== String(r.doc.id)) ||
          !Array.isArray(value?.payload?.segments) || !canonicalSelection(value?.anchor)) {
        r.status("这份译文暂时无法可靠对应当前原文，请重新选择。", {notice: true});
        return;
      }
      // Capture actual selected ink before the pane changes the paper geometry.
      // The spread's reading start can belong to a different, unselected passage.
      const view = r.captureView({within: value.anchor});
      const anchor = view.visibleAnchor ||
        (r.sourceParts(view.readingAnchor) ? view.readingAnchor : null);
      cancelNavigation();
      locked = null;
      r.cancelHighlight();
      result = value;
      paint();
      const request = begin("layout");
      const landing = r.pages.reflow(anchor || undefined);
      request.epoch = r.pages.layoutEpoch;
      void preserveView(request, anchor, landing);
    };
    const translate = async (anchor) => {
      cancelNavigation();
      const generation = ++openGeneration;
      const documentId = r.doc.id, version = r.doc.version;
      if (!canonicalSelection(anchor)) return;
      if (result && sameSelection(anchor, result.anchor)) {
        r.showTranslation(result);
        return;
      }
      const pending = r.requestAssist("translation", anchor);
      openRequest = r.pending.get("translation") || null;
      const value = await pending;
      if (generation !== openGeneration || r.scope.signal.aborted ||
          documentId !== r.doc.id || version !== r.doc.version ||
          !sameSelection(r.selection, anchor)) return;
      openRequest = null;
      if (value) r.showTranslation(value);
    };
    r.selectionAction("translation", "翻译所选文字", translate);
    r.tool("translate", "选区翻译", () => {
      if (r.selection) translate({ ...r.selection });
      else r.status("请在原文选择文字，或点击段落下的“选择这一段”。");
    });
    const highlight = (i) => {
      if (!result || pane.hidden) return;
      const mapped = i == null ? null : mapping(i);
      r.paintRanges(result.anchor, mapped ? [result.payload.segments[i]] : []);
      $$("[data-pair]", pane).forEach((el) => {
        const active = Boolean(mapped) && +el.dataset.pair === i;
        el.classList.toggle("active", active);
        el.setAttribute("aria-current", String(active));
      });
    };
    const mapping = (i) => {
      const segment = result?.payload.segments[i];
      if (!segment || !currentResult()) return null;
      const parts = linkedRanges(result.anchor, [segment]);
      const selected = anchorSegments(result.anchor);
      if (!parts.length || parts.some(part => {
        const block = r.doc.blocks.find(block => block.id === part.block_id);
        return !block || !Number.isInteger(part.start) || !Number.isInteger(part.end) ||
          part.start < 0 || part.end <= part.start || part.end > block.text.length ||
          (part.version != null && part.version !== r.doc.version) ||
          (part.quote != null && block.text.slice(part.start, part.end) !== part.quote) ||
          !pdfMatches(part, r.anchorFor(part.block_id, part.start, part.end)) ||
          !selected.some(range => range.block_id === part.block_id &&
            range.start <= part.start && range.end >= part.end);
      })) return null;
      let previousBlock = -1, previousEnd = 0;
      for (const part of parts) {
        const index = r.doc.blocks.findIndex(block => block.id === part.block_id);
        if (index < previousBlock || (index === previousBlock && part.start < previousEnd)) return null;
        previousBlock = index;
        previousEnd = part.end;
      }
      const quote = parts.map(part => r.doc.blocks.find(block => block.id === part.block_id)
        .text.slice(part.start, part.end)).join("\n\n");
      return quote === segment.quote ? {parts, anchor: combineSelection(parts.map(part =>
        r.anchorFor(part.block_id, part.start, part.end)))} : null;
    };
    const unavailable = () => {
      highlight(null);
      r.status("这句译文暂时无法可靠定位原文，请重新选择原文。", {notice: true});
    };
    const locate = (i, delay = 120, origin = "hover") => {
      if (!result || pane.hidden) return;
      const mapped = mapping(i);
      const request = begin("pair");
      request.i = i;
      request.origin = origin;
      request.epoch = r.pages.layoutEpoch;
      if (!mapped) { finish(request); unavailable(); return; }
      request.run = async () => {
        hoverTimer = 0;
        try {
          if (!await stable(request)) return;
          const current = mapping(i);
          if (!current) { unavailable(); return; }
          if (!r.isAnchorVisible(current.anchor)) {
            const restored = await r.restore(current.anchor, {mark: false, signal: request.controller.signal});
            if (!restored || !await stable(request)) return;
          }
          if (request.current() && mapping(i) && r.isAnchorVisible(current.anchor)) {
            locked = i;
            highlight(i);
          }
        } catch (error) {
          if (request.current() && error.name !== "AbortError") unavailable();
        } finally { finish(request); }
      };
      if (delay) hoverTimer = setTimeout(request.run, delay);
      else void request.run();
    };
    r.scope.on(closeControl, "click", () => {
      const view = r.captureView();
      const anchor = view.visibleAnchor ||
        (r.sourceParts(view.readingAnchor) ? view.readingAnchor : null);
      cancelOpen();
      cancelNavigation();
      highlight(null);
      pane.hidden = true;
      $(".reading-columns").classList.remove("has-translation");
      locked = null;
      syncCloseControl();
      const request = begin("layout", true);
      const landing = r.pages.reflow(anchor || undefined);
      request.epoch = r.pages.layoutEpoch;
      void preserveView(request, anchor, landing);
    });
    r.scope.on(pane, "pointerover", (ev) => {
      const b = ev.target.closest("[data-pair]");
      if (b && !b.contains(ev.relatedTarget) && target?.origin !== "click")
        locate(+b.dataset.pair);
    });
    r.scope.on(pane, "focusin", (ev) => {
      const b = ev.target.closest("[data-pair]");
      if (b) locate(+b.dataset.pair, 0, "focus");
    });
    r.scope.on(pane, "pointerout", (ev) => {
      const pair = ev.target.closest("[data-pair]");
      if (!pair || pair.contains(ev.relatedTarget)) return;
      if (target?.origin === "hover" && target.i === +pair.dataset.pair)
        cancelNavigation();
      highlight(locked);
    });
    r.scope.on(pane, "focusout", (ev) => {
      const pair = ev.target.closest("[data-pair]");
      if (!pair || pair.contains(ev.relatedTarget)) return;
      if (target?.origin === "focus" && target.i === +pair.dataset.pair)
        cancelNavigation();
    });
    r.scope.on(pane, "click", async (ev) => {
      const b = ev.target.closest("[data-pair]");
      if (b) {
        locate(+b.dataset.pair, 0, "click");
        return;
      }
      if (ev.target.closest("[data-return-translation]")) {
        const anchor = canonicalSelection(result?.anchor);
        const request = begin("return");
        request.epoch = r.pages.layoutEpoch;
        locked = null;
        highlight(null);
        void (async () => {
          try {
            if (anchor && await stable(request))
              await r.restore(anchor, {mark: false, signal: request.controller.signal});
          } finally { finish(request); }
        })().catch(() => r.status("原文暂时无法定位，请重新选择。", {notice: true}));
      }
      if (ev.target.closest("[data-translation-note]")) {
        const anchor = canonicalSelection(result?.anchor);
        if (!anchor) { unavailable(); return; }
        r.choose(anchor);
        r.selectionActions.get("notes")?.fn(anchor);
      }
    });
    r.scope.on($("#article"), "pointerover", (ev) => {
      const word = ev.target.closest("[data-source-start]");
      if (
        !word ||
        !result || pane.hidden
      )
        return;
      const i = result.payload.segments.findIndex(
        (v, index) => mapping(index)?.parts.some(part =>
          word.dataset.sourceBlock === part.block_id &&
          +word.dataset.sourceStart < part.end && +word.dataset.sourceEnd > part.start),
      );
      if (i >= 0) {
        if (target?.kind === "pair" && target.origin !== "click") cancelNavigation();
        const mapped = mapping(i);
        if (mapped && r.isAnchorVisible(mapped.anchor)) highlight(i);
      }
    });
    r.scope.on($("#article"), "pointerout", (ev) => {
      const word = ev.target.closest("[data-source-start]");
      if (word && !word.contains(ev.relatedTarget)) highlight(locked);
    });
    r.on("draw", () => {
      if (!target && locked !== null) {
        const i = locked, token = navigation, epoch = r.pages.layoutEpoch;
        void r.pages.whenStable({epoch, signal: r.scope.signal}).then(settled => {
          if (!settled || token !== navigation || locked !== i || target || pane.hidden) return;
          const mapped = mapping(i);
          highlight(mapped && r.isAnchorVisible(mapped.anchor) ? i : null);
        });
      }
    });
    r.on("before-page", (ev) => {
      // Repagination preserves the same source anchor; only navigation clears
      // the pinned sentence. The next draw repaints its visible text ranges.
      if (ev.detail?.reflow) return;
      locked = null;
      highlight(null);
    });
    r.on("before-selection", () => {
      cancelOpen();
      cancelNavigation();
      locked = null;
      highlight(null);
    });
    r.on("before-navigation", () => { cancelNavigation(); cancelOpen(); });
    r.scope.on(document, "keydown", (ev) => {
      if (ev.key !== "Escape") return;
      cancelOpen();
      cancelNavigation();
      locked = null;
      highlight(null);
    });
  });
}
