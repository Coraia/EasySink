import { $, $$, e, api, toast } from "./core.js";

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
    r.selectedTextRanges = [];
    $$("#article .source-unit").forEach((el) =>
      el.classList.toggle(
        "is-selected",
        Boolean(
          anchor &&
          el.dataset.sourceBlock === anchor.block_id &&
          +el.dataset.sourceStart < anchor.end &&
          +el.dataset.sourceEnd > anchor.start,
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
      if (block.dataset.block !== anchor.block_id) return;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      let offset = +block.dataset.start,
        node;
      while ((node = walker.nextNode())) {
        if (node.parentElement.closest(".gloss,.bookmark-marker")) continue;
        const end = offset + node.textContent.length;
        if (offset < anchor.end && end > anchor.start) {
          const range = document.createRange();
          range.setStart(node, Math.max(0, anchor.start - offset));
          range.setEnd(
            node,
            Math.min(node.textContent.length, anchor.end - offset),
          );
          ranges.push(range);
          r.selectedTextRanges.push({ range, start: offset, end, block });
        }
        offset = end;
      }
    });
    if (globalThis.CSS?.highlights && globalThis.Highlight)
      CSS.highlights.set("reader-selection", new Highlight(...ranges));
  };
  r.positionSelection = () => {
    const menu = $("#reading-selection");
    if (!menu) return;
    if (!r.selection || r.selecting || r.focus.isOpen() || r.panelId) {
      menu.hidden = true;
      return;
    }
    const point =
      r.selectionPlacement?.block_id === r.selection.block_id
        ? r.selectionPlacement
        : { offset: r.selection.end, trigger: "range" };
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
          el.dataset.fragment === r.selection.block_id &&
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
    if (!target) {
      const candidates = (r.selectedTextRanges || []).filter(
        (v) => v.start < point.offset,
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
    const above = rect.bottom + 10 + box.height > lower;
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
          above ? rect.top - box.height - 10 : rect.bottom + 10,
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
      el.innerHTML = `<div class="selection-quote">${image ? "已选原图" : "已选原文"} · ${e(r.selection.quote.length > 110 ? r.selection.quote.slice(0, 110) + "…" : r.selection.quote)}</div><div class="selection-actions" role="toolbar" aria-label="所选原文操作">${actions.map(([id, { label }]) => `<button type="button" data-selection-action="${id}">${e(r.pending.has(id) ? "取消" + label : label)}</button>`).join("")}<button type="button" data-selection-clear aria-label="取消选择" title="取消选择">×</button></div>${!image && r.ctx.enabled("grammar") ? '<div class="selection-scope">语法分析按完整句子处理；翻译、朗读和笔记仍按当前选区。</div>' : ""}`;
    }
    r.emit("selection-render");
    r.positionSelection();
  };
  r.choose = (anchor, origin) => {
    r.emit("before-selection");
    r.selection = { ...anchor };
    r.selectionPlacement = {
      block_id: anchor.block_id,
      offset: origin
        ? +origin.closest(".source-fragment").dataset.fragmentEnd
        : anchor.end,
      trigger: origin ? "paragraph" : "range",
    };
    r.closePop();
    r.renderSelection();
    r.ctx.run("selection", r).catch(console.error);
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
      if (err.name !== "AbortError") r.status(err.message, { notice: true });
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
    $$("#article .source-unit").forEach((el) =>
      el.classList.toggle(
        "linked-" + kind,
        el.dataset.sourceBlock === anchor.block_id &&
          ranges.some(
            (v) =>
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
        if (block.dataset.block !== anchor.block_id) return;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let offset = +block.dataset.start, node;
        while ((node = walker.nextNode())) {
          if (node.parentElement.closest(".gloss,.bookmark-marker")) continue;
          const end = offset + node.textContent.length;
          for (const part of ranges) {
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
    const action = ev.target.closest("[data-selection-action]");
    if (action && r.selection)
      Promise.resolve(
        r.selectionActions
          .get(action.dataset.selectionAction)
          ?.fn({ ...r.selection }),
      ).catch((err) => r.status(err.message));
    if (ev.target.closest("[data-selection-clear]")) {
      r.emit("before-selection");
      for (const controller of r.pending.values()) controller.cancel();
      r.pending.clear();
      r.selection = null;
      getSelection()?.removeAllRanges();
      r.renderSelection();
      r.emit("assist-change");
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
  r.scope.on($("#article"), "pointerdown", () => {
    r.selecting = true;
    r.positionSelection();
  });
  const endSelectionGesture = () => {
    r.selecting = false;
    schedulePosition();
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
  r.enhancePop = async (pop, item, anchor, scope) => {
    if (!anchor) return;
    const word = anchor.quote.normalize("NFKC");
    let result;
    if (/^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(word)) {
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
    const pronunciation = document.createElement("div");
    pronunciation.className = "word-pronunciation";
    pronunciation.innerHTML = `${result?.phonetic ? `<span data-word-ipa>/${e(result.phonetic.replace(/^\[|\]$|^\/|\/$/g, ""))}/</span>` : ""}${r.ctx.enabled("tts") ? '<button type="button" data-word-speak>听发音</button>' : ""}`;
    $("h3", pop).after(pronunciation);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-action";
    button.textContent = "解释这里的意思";
    const content = document.createElement("div");
    content.className = "context-result";
    content.setAttribute("role", "status");
    pop.append(button, content);
    let controller;
    scope.on(button, "click", async () => {
      if (controller) {
        controller.cancel();
        controller = null;
        button.textContent = "解释这里的意思";
        content.textContent = "";
        return;
      }
      controller = r.assistController();
      const current = controller;
      button.textContent = "取消解释";
      content.textContent = "正在结合上下文…";
      try {
        const value = await api(`/documents/${r.doc.id}/context`, {
          method: "POST",
          body: { anchor, request_id: controller.requestId },
          signal: controller.signal,
        });
        if (scope.signal.aborted || controller !== current) return;
        if (!r.assists.some((a) => a.id === value.id)) r.assists.push(value);
        content.innerHTML = `<div class="meta">${e(value.source)}</div><p>${e(value.payload.meaning)}</p><p>${e(value.payload.explanation)}</p>`;
        button.textContent = "重新查看上下文";
      } catch (err) {
        if (err.name !== "AbortError" && !scope.signal.aborted)
          content.textContent = err.message;
      } finally {
        if (controller === current) {
          controller = null;
          button.textContent = "解释这里的意思";
        }
      }
    });
    scope.on(pronunciation, "click", (ev) => {
      if (ev.target.closest("[data-word-speak]")) r.speech?.toggle(anchor);
    });
    r.emit("speech-controls");
    scope.cleanup(() => {
      controller?.cancel();
      if (
        r.speech?.anchor?.block_id === anchor.block_id &&
        r.speech.anchor.start === anchor.start &&
        r.speech.anchor.end === anchor.end
      )
        r.speech.stop();
    });
  };
}
