import { installSelectionHandles } from "./selection-handles.js";
import { installSelectionDragRecovery } from "./selection-drag.js";
import { anchorSegments, linkedRanges } from "./source-selection.js";
import { $, $$, e, api, toast } from "./core.js";
import { offerAISetup } from "./ai-setup-guard.js";
import { installContextPopup } from "./assist-popup.js";

export function setupReadingInteractions(r) {
  r.events = new EventTarget();
  r.selectionActions = new Map();
  r.assists = [];
  r.pending = new Map();
  r.emit = (name, detail) => r.events.dispatchEvent(new CustomEvent(name, {detail}));
  r.on = (name, fn) => r.scope.on(r.events, name, fn);
  r.status = (text, { notice = false } = {}) => {
    if (r.scope.signal.aborted) return;
    $("#reader-save").textContent = text;
    // Guidance/errors must remain visible after consolidating the old footer
    // into a normally hidden banner. Successful background saves stay quiet.
    if (
      !r.focus.isOpen() &&
      (notice || /^(先|请|已到)|失败|无法|未能|暂时|未配置|还没有/.test(text))
    )
      toast(text);
  };
  r.anchorFor = (id, start, end) => {
    const b = r.doc.blocks.find((b) => b.id === id);
    if (!b) return null;
    const image = Boolean(b.asset_url && ["image", "image_fallback", "formula", "table"].includes(b.type));
    return {
      version: r.doc.version,
      block_id: id,
      start,
      end,
      quote: image && end > start ? (b.caption || `原图 · 原页 ${b.source?.page_number || ""}`) : b.text.slice(start, end),
      prefix: b.text.slice(Math.max(0, start - 40), start),
      suffix: b.text.slice(end, end + 40),
      ratio: r.pages?.anchor?.ratio || 0,
      ...(b.source && r.doc.pdf ? {
        kind: image ? "image" : "text",
        pdf_source: { ...b.source, book_id: r.doc.pdf.book_id, source_sha256: r.doc.pdf.source_sha256, ...(image ? {asset_url: b.asset_url} : {}) },
      } : {}),
    };
  };
  r.selectionAction = (id, label, fn) => {
    r.selectionActions.set(id, { label, fn });
    r.renderSelection();
  };
  r.paintSelection = () => {
    const anchor = r.selection;
    const parts = anchorSegments(anchor);
    r.selectedTextRanges = [];
    $$("#article .source-unit").forEach((el) =>
      el.classList.toggle(
        "is-selected",
        Boolean(
          parts.some(part => el.dataset.sourceBlock === part.block_id &&
          +el.dataset.sourceStart < part.end && +el.dataset.sourceEnd > part.start),
        ),
      ),
    );
    globalThis.CSS?.highlights?.delete("reader-selection");
    $$("#article [data-pdf-object]").forEach((el) =>
      el.classList.toggle("is-selected", Boolean(anchor?.kind === "image" && el.dataset.pdfObject === anchor.block_id)),
    );
    if (!anchor) return;
    if (anchor.kind === "image") return;
    const ranges = [];
    $$("#article [data-block]").forEach((block) => {
      const part = parts.find(p => p.block_id === block.dataset.block);
      if (!part) return;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let offset = +block.dataset.start,
        node;
      while ((node = walker.nextNode())) {
        if (node.parentElement.closest(".gloss,.bookmark-marker,.note-marker")) continue;
        const end = offset + node.textContent.length;
        if (offset < part.end && end > part.start) {
          const range = document.createRange();
          range.setStart(node, Math.max(0, part.start - offset));
          range.setEnd(
            node,
            Math.min(node.textContent.length, part.end - offset),
          );
          ranges.push(range);
          r.selectedTextRanges.push({ range, start: offset, end, block });
        }
        offset = end;
      }
    });
    const precise = Boolean(globalThis.CSS?.highlights && globalThis.Highlight);
    $(".reader").classList.toggle("precise-selection", precise);
    if (precise) CSS.highlights.set("reader-selection", new Highlight(...ranges));
  };
  r.positionSelection = () => {
    const menu = $("#reading-selection");
    r.positionSelectionHandles?.();
    if (!menu) return;
    if (!r.selection || r.selecting || r.adjustingSelection || r.aiSetupOpen || r.grammarInspecting || r.focus.isOpen() || r.panelId) {
      menu.hidden = true;
      return;
    }
    const last = anchorSegments(r.selection).at(-1);
    const point = r.selectionPlacement || { block_id: last.block_id, offset: last.end, trigger: "range" };
    let target;
    const visible = (rect, leaf) =>
      rect.width &&
      rect.height &&
      rect.bottom > Math.max(leaf.top, 0) &&
      rect.top < Math.min(leaf.bottom, innerHeight);
    if (r.selection.kind === "image") {
      const object = $$("#article [data-pdf-object]").find(el => el.dataset.pdfObject === r.selection.block_id);
      const leaf = object?.closest(".page-leaf");
      if (object && leaf && visible(object.getBoundingClientRect(), leaf.getBoundingClientRect()))
        target = {rect: object.getBoundingClientRect(), leaf: leaf.getBoundingClientRect()};
    }
    if (point.trigger === "paragraph") {
      const fragment = $$("#article .source-fragment").find(
        (el) =>
          el.dataset.fragment === point.block_id &&
          +el.dataset.fragmentStart < point.offset &&
          +el.dataset.fragmentEnd >= point.offset,
      );
      const button = fragment?.querySelector("[data-select-block]");
      const leaf = fragment?.closest(".page-leaf");
      if (
        button &&
        // Expanded inline grammar can move the action row far below the prose.
        // In that case anchor to the selected source, rather than the analysis.
        Math.abs(
          button.getBoundingClientRect().top -
            fragment.querySelector(".source-row").getBoundingClientRect()
              .bottom,
        ) < 48 &&
        visible(button.getBoundingClientRect(), leaf.getBoundingClientRect())
      )
        target = {
          rect: button.getBoundingClientRect(),
          leaf: leaf.getBoundingClientRect(),
        };
    }
    if (!target && point.trigger === "range") {
      const first = anchorSegments(r.selection)[0];
      const atStart = point.block_id === first.block_id && point.offset === first.start;
      const runs = (r.selectedTextRanges || []).filter(v =>
        v.block.dataset.block === point.block_id && v.start <= point.offset && v.end >= point.offset);
      for (const run of atStart ? runs : runs.toReversed()) {
        const leaf = run.block.closest(".page-leaf").getBoundingClientRect();
        const rects = [...run.range.getClientRects()].filter(rect => visible(rect, leaf));
        if (rects.length) { target = { rect: atStart ? rects[0] : rects.at(-1), leaf }; break; }
      }
    }
    if (!target) {
      const candidates = (r.selectedTextRanges || []).filter(
        (v) => v.block.dataset.block !== point.block_id || v.start < point.offset,
      );
      for (const v of candidates.reverse()) {
        const leaf = v.block.closest(".page-leaf").getBoundingClientRect();
        const rects = [...v.range.getClientRects()].filter((rect) =>
          visible(rect, leaf),
        );
        if (rects.length) {
          target = { rect: rects.at(-1), leaf };
          break;
        }
      }
    }
    if (!target) {
      menu.hidden = true;
      return;
    }
    const { rect, leaf } = target;
    menu.hidden = false;
    menu.style.maxWidth =
      Math.max(120, Math.min(480, innerWidth - 24, leaf.width - 24)) + "px";
    const box = menu.getBoundingClientRect();
    const lower = Math.min(innerHeight - 12, leaf.bottom - 8);
    const gap = 20; // Leave the endpoint knob accessible beside the menu.
    const above = rect.bottom + gap + box.height > lower;
    menu.style.left =
      Math.max(
        Math.max(12, leaf.left + 12),
        Math.min(
          rect.left + rect.width / 2 - box.width / 2,
          Math.min(innerWidth - 12, leaf.right - 12) - box.width,
        ),
      ) + "px";
    menu.style.top =
      Math.max(
        12,
        Math.min(
          lower - box.height,
          above ? rect.top - box.height - gap : rect.bottom + gap,
        ),
      ) + "px";
    menu.dataset.placement = above ? "above" : "below";
  };
  r.renderSelection = () => {
    r.paintSelection();
    const el = $("#reading-selection");
    if (!el) return;
    el.hidden = !r.selection;
    if (r.selection) {
      const image = r.selection.kind === "image";
      const actions = [...r.selectionActions].filter(([id]) => !image || ["notes", "bookmarks", "pdf-source"].includes(id));
      const primaryIds = ["collections-highlight", "notes", "translation", "grammar"];
      const primary = image ? actions : primaryIds.flatMap(id => actions.filter(([key]) => key === id));
      const secondary = image ? [] : actions.filter(([id]) => !primaryIds.includes(id));
      const button = ([id, { label }], compact = false) => {
        const name = compact ? ({ notes: "笔记", translation: "翻译", grammar: "语法" }[id] || label) : label;
        return `<button type="button" data-selection-action="${e(id)}" title="${e(label)}">${e(r.pending.has(id) ? "取消" + name : name)}</button>`;
      };
      const extraPending = secondary.some(([id]) => r.pending.has(id));
      el.innerHTML = `<div class="selection-quote">${image ? "已选原图" : "已选原文"} · ${e(r.selection.quote.length > 110 ? r.selection.quote.slice(0, 110) + "…" : r.selection.quote)}</div>
        <div class="selection-actions" role="toolbar" aria-label="所选原文操作">${primary.map(action => button(action, !image)).join("")}
          ${secondary.length ? `<button type="button" data-selection-more aria-controls="selection-more-actions" aria-expanded="${Boolean(r.selectionMoreOpen)}">更多${extraPending ? " · 可取消" : ""}</button>` : ""}
          <button type="button" data-selection-clear aria-label="取消选择" title="取消选择">×</button></div>
        ${secondary.length ? `<div id="selection-more-actions" class="selection-actions" role="toolbar" aria-label="更多原文操作" ${r.selectionMoreOpen ? "" : "hidden"}>${secondary.map(action => button(action)).join("")}</div>` : ""}
        ${!image && r.ctx.enabled("grammar") ? '<div class="selection-scope">语法分析按完整句子处理；翻译、朗读和笔记仍按当前选区。</div>' : ""}`;
    }
    r.emit("selection-render");
    r.positionSelection();
  };
  r.choose = (anchor, origin) => {
    r.emit("before-selection");
    for (const controller of r.pending.values()) controller.cancel();
    r.pending.clear();
    r.selection = { ...anchor };
    r.selectionMoreOpen = false;
    const last = anchorSegments(anchor).at(-1);
    r.selectionPlacement = {
      block_id: last.block_id,
      offset: origin
        ? +origin.closest(".source-fragment").dataset.fragmentEnd
        : last.end,
      trigger: origin ? "paragraph" : "range",
    };
    r.closePop();
    r.renderSelection();
    r.ctx.run("selection", r).catch(console.error);
  };
  r.clearSelection = ({ native = true } = {}) => {
    r.emit("before-selection");
    for (const controller of r.pending.values()) controller.cancel();
    r.pending.clear();
    r.selection = null;
    r.selectionMoreOpen = false;
    r.selectionPlacement = null;
    if (native) getSelection()?.removeAllRanges();
    r.renderSelection();
    r.emit("assist-change");
  };
  r.assistController = (docId = r.doc.id) => {
    const controller = new AbortController();
    controller.requestId = crypto.randomUUID();
    controller.cancel = () => {
      controller.abort();
      api(`/documents/${docId}/assist-requests/${controller.requestId}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => r.status("取消记录未能送达，请检查连接后刷新阅读痕迹。"));
    };
    return controller;
  };
  r.requestAssist = async (kind, anchor) => {
    const old = r.pending.get(kind);
    if (old) {
      old.cancel();
      r.pending.delete(kind);
      r.renderSelection();
      r.emit("assist-change");
      return null;
    }
    const controller = r.assistController();
    r.pending.set(kind, controller);
    r.renderSelection();
    r.emit("assist-change");
    try {
      const result = await api(
        `/documents/${r.doc.id}/${{ translation: "translate-selection", grammar: "grammar", context: "context" }[kind]}`,
        {
          method: "POST",
          body: { anchor, request_id: controller.requestId },
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || r.scope.signal.aborted) return null;
      const index = r.assists.findIndex((a) => a.id === result.id);
      if (index < 0) r.assists.push(result);
      else r.assists[index] = result;
      return result;
    } catch (err) {
      if (err.name !== "AbortError" && !offerAISetup(r, anchor, err, kind))
        r.status(err.message, { notice: true });
      return null;
    } finally {
      if (r.pending.get(kind) === controller) r.pending.delete(kind);
      if (!r.scope.signal.aborted) {
        r.renderSelection();
        r.emit("assist-change");
      }
    }
  };
  r.paintRanges = (anchor, ranges, kind = "translation") => {
    ranges = linkedRanges(anchor, ranges);
    $$("#article .source-unit").forEach((el) =>
      el.classList.toggle(
        "linked-" + kind,
        ranges.some(
            (v) =>
              el.dataset.sourceBlock === v.block_id &&
              +el.dataset.sourceStart < v.end &&
              +el.dataset.sourceEnd > v.start,
          ),
      ),
    );
    // A text selection paints above element backgrounds. Give the linked
    // sentence its own higher-priority range, including spaces/punctuation.
    if (kind === "translation" && globalThis.CSS?.highlights && globalThis.Highlight) {
      const linked = [];
      $$("#article [data-block]").forEach((block) => {
        const parts = ranges.filter(v => v.block_id === block.dataset.block);
        if (!parts.length) return;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let offset = +block.dataset.start, node;
        while ((node = walker.nextNode())) {
          if (node.parentElement.closest(".gloss,.bookmark-marker")) continue;
          const end = offset + node.textContent.length;
          for (const part of parts) {
            if (offset >= part.end || end <= part.start) continue;
            const range = document.createRange();
            range.setStart(node, Math.max(0, part.start - offset));
            range.setEnd(node, Math.min(node.textContent.length, part.end - offset));
            linked.push(range);
          }
          offset = end;
        }
      });
      CSS.highlights.delete("reader-translation");
      if (linked.length) {
        const highlight = new Highlight(...linked);
        highlight.priority = 2;
        CSS.highlights.set("reader-translation", highlight);
      }
    }
  };
  r.cancelHighlight = () => {
    globalThis.CSS?.highlights?.delete("reader-translation");
    $$("#article .source-unit").forEach((el) =>
      el.classList.remove(
        "linked-translation",
        "linked-grammar",
        "linked-reference",
      ),
    );
  };
  r.scope.cleanup(() => {
    globalThis.CSS?.highlights?.delete("reader-selection");
    globalThis.CSS?.highlights?.delete("reader-translation");
  });
  r.on("before-navigation", () => {
    for (const controller of r.pending.values()) controller.cancel();
    r.pending.clear();
    r.renderSelection();
    r.emit("assist-change");
  });
  r.scope.on($("#reading-selection"), "click", (ev) => {
    if (ev.target.closest("[data-selection-more]")) {
      r.selectionMoreOpen = !r.selectionMoreOpen;
      r.renderSelection();
      $("[data-selection-more]", $("#reading-selection"))?.focus({ preventScroll: true });
      return;
    }
    const action = ev.target.closest("[data-selection-action]");
    if (action && r.selection)
      Promise.resolve(
        r.selectionActions
          .get(action.dataset.selectionAction)
          ?.fn({ ...r.selection }),
      ).catch((err) => r.status(err.message));
    if (ev.target.closest("[data-selection-clear]")) {
      r.clearSelection();
    }
  });
  r.scope.on($("#article"), "click", (ev) => {
    const select = ev.target.closest("[data-select-block]");
    if (select) {
      const block = r.doc.blocks.find(
        (b) => b.id === select.dataset.selectBlock,
      );
      getSelection()?.removeAllRanges();
      r.choose(r.anchorFor(block.id, 0, block.text.length), select);
    }
  });
  r.scope.on($("#article"), "pointermove", (ev) => {
    if (r.pages?.animating || ev.pointerType === "touch") return;
    const fragment = ev.target.closest(".source-fragment");
    $$("#article .actions-visible").forEach((el) => {
      if (el !== fragment) el.classList.remove("actions-visible");
    });
    fragment?.classList.add("actions-visible");
  });
  r.scope.on($("#article"), "pointerleave", () => {
    $$("#article .actions-visible").forEach((el) =>
      el.classList.remove("actions-visible"),
    );
  });
  let positionFrame;
  const schedulePosition = () => {
    cancelAnimationFrame(positionFrame);
    positionFrame = requestAnimationFrame(() => r.positionSelection());
  };
  r.scope.on(document, "pointerdown", (ev) => {
    r.selectionDismissedByPointer = false;
    if (r.aiSetupOpen) return;
    if (ev.button !== 0 || !r.selection) return;
    // Keep the anchor while operating its menu/panels. A new source gesture or
    // an outside click owns a fresh selection, including after native collapse.
    if (ev.target.closest(".selection-handles,#reading-selection,#tool-panel,#reader-chrome,#show-tools,.annotation-pop,#translation-pane,.inline-grammar,#toast")) return;
    r.selectionDismissedByPointer = true;
    r.clearSelection();
    if (ev.target.closest(".reading-edge-grip")) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  }, { capture: true });
  r.scope.on($("#article"), "pointerdown", (ev) => {
    if (ev.button !== 0 || (ev.target.closest("button,a,input,textarea,select") && !ev.target.closest(".source-unit"))) return;
    r.selecting = true;
    r.positionSelection();
  });
  let selectionFrame;
  installSelectionDragRecovery(r);
  const endSelectionGesture = () => {
    if (!r.selecting) return;
    r.selecting = false;
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(() => {
      r.captureSelection();
      r.positionSelection();
    });
  };
  r.scope.on(document, "pointerup", endSelectionGesture);
  r.scope.on(document, "pointercancel", endSelectionGesture);
  r.scope.on(document, "scroll", schedulePosition, {
    capture: true,
    passive: true,
  });
  r.scope.on(window, "resize", schedulePosition, { passive: true });
  r.scope.on(window.visualViewport, "resize", schedulePosition, {
    passive: true,
  });
  const menuResize = new ResizeObserver(schedulePosition);
  menuResize.observe($("#reading-selection"));
  r.scope.cleanup(() => {
    cancelAnimationFrame(positionFrame);
    cancelAnimationFrame(selectionFrame);
    menuResize.disconnect();
    r.selectedTextRanges = [];
  });
  r.scope.on(document, "keydown", (ev) => {
    if (
      ev.target.closest('input,textarea,select,[contenteditable="true"]') ||
      ev.altKey ||
      ev.ctrlKey ||
      ev.metaKey ||
      getSelection()?.toString()
    )
      return;
    if (ev.key === "Escape") r.cancelHighlight();
  });
  r.scope.cleanup(() => {
    globalThis.CSS?.highlights?.delete("reader-selection");
    for (const controller of r.pending.values()) controller.cancel();
    r.pending.clear();
  });
  installSelectionHandles(r);
  r.enhancePop = async (pop, item, anchor, scope) => {
    if (!anchor) return;
    installContextPopup(r, pop, anchor, scope);
    const word = anchor.quote.normalize("NFKC");
    const singleWord = /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(word);
    let result = item;
    if (!item.dictionary && word.trim() && word.length <= 96 && word.trim().split(/\s+/).length <= 6) {
      try {
        result = await api("/lookup", {
          method: "POST",
          body: { word, mark_unknown: false },
          signal: scope.signal,
        });
      } catch (err) {
        if (err.name === "AbortError") return;
      }
      if (scope.signal.aborted) return;
    }
    if (result?.dictionary) {
      item.dictionary = result.dictionary;
      pop.dictionaryRecord = result.dictionary;
      if (result !== item) r.renderDictionary?.(pop, item);
      r.emit("dictionary-record", { pop, item, anchor, dictionary: result.dictionary, record: result.dictionary, scope });
    }
    const pronunciation = document.createElement("div");
    pronunciation.className = "word-pronunciation";
    pronunciation.innerHTML = `${singleWord && result?.phonetic ? `<span data-word-ipa>/${e(result.phonetic.replace(/^\[|\]$|^\/|\/$/g, ""))}/</span>` : ""}${r.ctx.enabled("tts") ? '<button type="button" data-word-speak>听发音</button>' : ""}`;
    $("h3", pop).after(pronunciation);
    scope.on(pronunciation, "click", (ev) => {
      if (ev.target.closest("[data-word-speak]")) r.speech?.toggle(anchor);
    });
    r.emit("speech-controls");
    scope.cleanup(() => {
      if (
        r.speech?.anchor?.block_id === anchor.block_id &&
        r.speech.anchor.start === anchor.start &&
        r.speech.anchor.end === anchor.end
      )
        r.speech.stop();
    });
  };
}
