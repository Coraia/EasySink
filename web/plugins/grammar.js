import { anchorSegments, linkedRanges, rangeAnchor } from "../source-selection.js";
import { $, $$, e, local } from "../core.js";

export function install(ctx) {
  if (!document.querySelector("link[data-grammar-view]")) {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = new URL("../grammar-view.css", import.meta.url).href;
    stylesheet.dataset.grammarView = "";
    document.head.append(stylesheet);
  }
  return ctx.hook("read", (r) => {
    const article = $("#article"), key = `grammar-open:${r.doc.id}:${r.doc.version}`;
    const expanded = new Set(local.get(key, [])), branches = new Map(), chosenResults = new Map();
    let pendingAnchor = null, locked = null, preview = null, requestEpoch = 0, locateEpoch = 0;
    r.grammarInspecting = false;
    const results = (block) => r.assists.filter(a => a.kind === "grammar" && a.anchor.block_id === block);
    const current = (block) => results(block).find(a => a.id === chosenResults.get(block)) || results(block).at(-1);
    const byId = (id) => r.assists.find(a => a.kind === "grammar" && String(a.id) === String(id));
    const panels = () => $$(".inline-grammar:not([hidden])", article);
    const persist = () => local.set(key, [...expanded]);
    const rootOf = result => result.payload.nodes.find(n => n.parent === null);
    const clearPreview = () => {
      $$(".source-unit", article).forEach(el => el.classList.remove("linked-grammar", "linked-reference"));
      globalThis.CSS?.highlights?.delete("reader-grammar");
    };
    const inspect = (on) => {
      if (r.grammarInspecting === on) return;
      r.grammarInspecting = on;
      if (on) getSelection()?.removeAllRanges();
      r.positionSelection();
    };
    const highlight = (pair) => {
      clearPreview();
      if (!pair || !r.grammarInspecting) return;
      const {result, node} = pair;
      r.paintRanges(result.anchor, node.ranges, node.kind === "reference" ? "reference" : "grammar");
      // Range highlighting remains visible over the retained text selection.
      if (!globalThis.CSS?.highlights || !globalThis.Highlight) return;
      const ranges = linkedRanges(result.anchor, node.ranges), marked = [];
      $$("[data-block]", article).forEach(block => {
        const parts = ranges.filter(p => p.block_id === block.dataset.block);
        if (!parts.length) return;
        const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        let offset = +block.dataset.start, text;
        while ((text = walker.nextNode())) {
          if (text.parentElement.closest(".gloss,.bookmark-marker,.note-marker")) continue;
          const end = offset + text.length;
          for (const part of parts) {
            if (part.start >= end || part.end <= offset) continue;
            const range = document.createRange();
            range.setStart(text, Math.max(0, part.start - offset));
            range.setEnd(text, Math.min(text.length, part.end - offset));
            marked.push(range);
          }
          offset = end;
        }
      });
      if (marked.length) {
        const mark = new Highlight(...marked);
        mark.priority = 3;
        CSS.highlights.set("reader-grammar", mark);
      }
    };
    const pairFor = (el) => {
      const result = byId(el?.dataset.result);
      const node = result?.payload.nodes.find(n => n.id === el.dataset.grammarNode);
      return node ? {result, node} : null;
    };
    const samePair = (a, b) => a?.result.id === b?.result.id && a?.node.id === b?.node.id;
    const updateActive = () => {
      for (const panel of panels()) {
        const result = byId(panel.dataset.grammarResult);
        if (!result) continue;
        const pair = preview?.result.id === result.id ? preview : locked?.result.id === result.id ? locked : null;
        const node = pair?.node || rootOf(result);
        $$("[data-grammar-node]", panel).forEach(button => {
          const pinned = locked?.result.id === result.id && locked.node.id === button.dataset.grammarNode;
          const active = node.id === button.dataset.grammarNode;
          button.setAttribute("aria-pressed", String(pinned));
          button.classList.toggle("is-preview", Boolean(preview?.result.id === result.id && active));
          button.classList.toggle("is-current", active);
        });
        const detail = $(".grammar-detail", panel);
        const mode = pair === preview && pair ? "预览" : pair ? "已锁定" : "总览";
        const identity = `${node.id}:${mode}`;
        if (detail.dataset.identity === identity) continue;
        detail.dataset.identity = identity;
        const explanation = node.parent === null ? result.payload.summary : node.explanation;
        detail.innerHTML = `<div class="grammar-detail-heading"><span>${e(mode)}${node.parent === null ? "" : ` · ${e(node.label)}`}</span>${pair ? `<button type="button" data-grammar-locate="${e(node.id)}" data-result="${result.id}">定位原文</button>` : ""}</div><p>${e(explanation)}</p>`;
        detail.scrollTop = 0;
      }
      highlight(preview || locked);
    };
    const stopInspecting = () => {
      locked = preview = null;
      inspect(false);
      updateActive();
    };
    const visibleHost = (anchor) => {
      const parts = anchorSegments(anchor);
      const matches = $$(".source-fragment", article).filter(fragment => parts.some(part =>
        fragment.dataset.fragment === part.block_id && +fragment.dataset.fragmentStart < part.end && +fragment.dataset.fragmentEnd > part.start));
      // A cross-paragraph analysis follows the last visible source fragment,
      // never inserts its entire tree between the selected heading and prose.
      return matches.at(-1);
    };
    const scopeLabel = (anchor) => {
      const parts = anchorSegments(anchor);
      if (parts.length < 2) return "完整句子";
      const headings = parts.filter(p => r.doc.blocks.find(b => b.id === p.block_id)?.type === "heading").length;
      return headings ? `含标题 · ${parts.length - headings} 段原文` : `跨 ${parts.length} 段 · 完整句子`;
    };
    const renderTree = (result) => {
      const root = rootOf(result);
      if (!branches.has(result.id)) branches.set(result.id, new Set([root.id]));
      const open = branches.get(result.id);
      const tree = (node) => {
        const children = result.payload.nodes.filter(n => n.parent === node.id);
        const quote = linkedRanges(result.anchor, node.ranges).map(v => v.quote).join(" ↔ ");
        return `<div class="grammar-node-row">${children.length ? `<button type="button" data-grammar-branch="${e(node.id)}" data-result="${result.id}" aria-label="${open.has(node.id) ? "收起" : "展开"}${e(node.label)}" aria-expanded="${open.has(node.id)}">${open.has(node.id) ? "−" : "+"}</button>` : '<span class="grammar-spacer"></span>'}<button type="button" data-grammar-node="${e(node.id)}" data-result="${result.id}" aria-pressed="false"><span class="grammar-node-label">${e(node.label)}</span><span class="grammar-node-source" lang="en">${e(quote)}</span>${node.parent !== null ? `<span class="grammar-node-explanation">${e(node.explanation)}</span>` : ""}</button></div>${children.length ? `<div class="grammar-children" ${open.has(node.id) ? "" : "hidden"}>${children.map(tree).join("")}</div>` : ""}`;
      };
      return tree(root);
    };
    const paint = () => {
      if (r.scope.signal.aborted) return;
      const hosts = new Map();
      for (const block of new Set(r.assists.filter(a => a.kind === "grammar").map(a => a.anchor.block_id))) {
        const result = current(block), host = visibleHost(result.anchor);
        if (host) hosts.set(host, {result, block});
      }
      if (pendingAnchor && r.pending.has("grammar")) {
        const host = visibleHost(pendingAnchor);
        if (host) hosts.set(host, {block: pendingAnchor.block_id, waiting: true});
      }
      $$(".source-fragment", article).forEach(fragment => {
        const panel = $(".inline-grammar", fragment), slot = $(".grammar-slot", fragment);
        if (!panel || !slot) return;
        const assignment = hosts.get(fragment), {result, block, waiting} = assignment || {};
        const open = waiting || (result && expanded.has(block));
        const toggle = result ? `<button type="button" data-grammar-toggle="${e(block)}" aria-expanded="${Boolean(open)}" aria-label="${open ? "收起" : "展开"}${anchorSegments(result.anchor).length > 1 ? "选区" : "本段"}语法">${open ? "−" : "+"}</button>` : "";
        if (slot.innerHTML !== toggle) slot.innerHTML = toggle;
        panel.hidden = !open;
        panel.setAttribute("aria-busy", String(Boolean(waiting)));
        fragment.classList.toggle("grammar-fragment-open", Boolean(open));
        if (!open) {
          panel.replaceChildren();
          delete panel.dataset.grammarResult;
          return;
        }
        if (waiting) {
          panel.dataset.grammarResult = "pending";
          panel.innerHTML = `<div class="grammar-heading"><span>正在分析完整句子…</span><button type="button" data-grammar-cancel>取消分析</button></div><p class="grammar-scope">${e(scopeLabel(pendingAnchor))}</p>`;
          return;
        }
        // Do not rebuild a hovered/focused tree on unrelated assist updates.
        if (panel.dataset.grammarResult === String(result.id)) return;
        panel.dataset.grammarResult = String(result.id);
        panel.innerHTML = `<div class="grammar-heading"><span>语法分析</span><button type="button" data-grammar-toggle="${e(block)}">收起 −</button></div><div class="grammar-scope" title="${e(result.source)}">${e(scopeLabel(result.anchor))} · 悬停预览，点击锁定</div><div class="grammar-tree" role="group" aria-label="句子结构">${renderTree(result)}</div><div class="grammar-detail"></div>`;
      });
      $$(".page-leaf", article).forEach(leaf => leaf.classList.toggle("grammar-page-open", Boolean($(".inline-grammar:not([hidden])", leaf))));
      if (!panels().length && r.grammarInspecting) inspect(false);
      updateActive();
      r.positionSelection();
    };
    const show = (result) => {
      chosenResults.set(result.anchor.block_id, result.id);
      expanded.add(result.anchor.block_id);
      locked = preview = null;
      inspect(true);
      paint();
      persist();
      // Only reveal the result locally. Page indices/source anchors never change.
      const panel = panels().find(el => el.dataset.grammarResult === String(result.id));
      const leaf = panel?.closest(".page-leaf");
      if (leaf) {
        const overflow = panel.getBoundingClientRect().bottom - leaf.getBoundingClientRect().bottom + 20;
        if (overflow > 0) leaf.scrollTop += overflow;
      }
    };
    r.selectionAction("grammar", "语法分析", async (anchor) => {
      const token = ++requestEpoch;
      if (r.pending.has("grammar")) {
        await r.requestAssist("grammar", anchor);
        pendingAnchor = null;
        stopInspecting();
        paint();
        return;
      }
      const existing = r.assists.filter(a => a.kind === "grammar").find(a =>
        anchorSegments(anchor).every(part => anchorSegments(a.anchor).some(saved =>
          saved.block_id === part.block_id && saved.start <= part.start && saved.end >= part.end)));
      if (existing) { show(existing); return; }
      pendingAnchor = anchor;
      inspect(true);
      const result = await r.requestAssist("grammar", anchor);
      if (token !== requestEpoch || r.scope.signal.aborted) return;
      pendingAnchor = null;
      if (result) show(result);
      else { stopInspecting(); paint(); }
    });
    r.on("draw", paint);
    r.on("assist-change", paint);
    r.on("before-selection", () => {
      ++locateEpoch;
      ++requestEpoch;
      pendingAnchor = null;
      stopInspecting();
      paint();
    });
    r.on("before-navigation", () => { ++locateEpoch; });
    r.on("before-page", ev => {
      if (ev.detail?.reflow) return;
      ++requestEpoch;
      pendingAnchor = null;
      stopInspecting();
    });
    r.scope.on(article, "click", async ev => {
      const toggle = ev.target.closest("[data-grammar-toggle]");
      if (toggle) {
        const block = toggle.dataset.grammarToggle;
        if (!expanded.has(block)) { const result = current(block); if (result) show(result); }
        else { expanded.delete(block); stopInspecting(); paint(); persist(); }
        return;
      }
      if (ev.target.closest("[data-grammar-cancel]")) {
        ++requestEpoch;
        r.pending.get("grammar")?.cancel();
        r.pending.delete("grammar");
        pendingAnchor = null;
        stopInspecting();
        paint();
        r.renderSelection();
        return;
      }
      const branch = ev.target.closest("[data-grammar-branch]");
      if (branch) {
        const result = byId(branch.dataset.result), open = branches.get(result.id);
        if (open.has(branch.dataset.grammarBranch)) open.delete(branch.dataset.grammarBranch);
        else open.add(branch.dataset.grammarBranch);
        inspect(true);
        branch.setAttribute("aria-expanded", String(open.has(branch.dataset.grammarBranch)));
        branch.textContent = open.has(branch.dataset.grammarBranch) ? "−" : "+";
        const node = result.payload.nodes.find(n => n.id === branch.dataset.grammarBranch);
        branch.setAttribute("aria-label", `${open.has(node.id) ? "收起" : "展开"}${node.label}`);
        branch.closest(".grammar-node-row").nextElementSibling.hidden = !open.has(node.id);
        return;
      }
      const node = ev.target.closest("[data-grammar-node]");
      if (node) {
        const pair = pairFor(node);
        if (!pair) return;
        inspect(true);
        locked = samePair(locked, pair) ? null : pair;
        preview = null;
        updateActive();
        return;
      }
      const locate = ev.target.closest("[data-grammar-locate]");
      if (locate) {
        const result = byId(locate.dataset.result), node = result?.payload.nodes.find(n => n.id === locate.dataset.grammarLocate);
        if (!node) return;
        const target = rangeAnchor(result.anchor, node.ranges[0]);
        const source = $$("[data-block]", article).find(el => el.dataset.block === target.block_id && +el.dataset.start <= target.start && +el.dataset.end > target.start);
        if (source) {
          const leaf = source.closest(".page-leaf"), box = source.getBoundingClientRect(), paper = leaf.getBoundingClientRect();
          if (box.top < paper.top + 24 || box.bottom > paper.bottom - 24) leaf.scrollTop += box.top - paper.top - 36;
          locked = {result, node}; preview = null; inspect(true); updateActive();
        } else {
          // Only this explicit control may move to another reading page.
          const token = ++locateEpoch;
          const restored = await r.restore(target, {mark: false});
          if (restored && !r.scope.signal.aborted && locateEpoch === token) {
            locked = {result, node}; preview = null; inspect(true); updateActive();
          }
        }
      }
    });
    const sourceNode = (unit) => {
      const result = panels().map(el => byId(el.dataset.grammarResult)).find(value => value &&
        anchorSegments(value.anchor).some(p => p.block_id === unit.dataset.sourceBlock));
      if (!result) return null;
      const start = +unit.dataset.sourceStart, end = +unit.dataset.sourceEnd;
      const candidates = result.payload.nodes.filter(n => n.parent !== null).flatMap(node =>
        linkedRanges(result.anchor, node.ranges).filter(p => p.block_id === unit.dataset.sourceBlock && p.start <= start && p.end >= end)
          .map(part => ({node, width: part.end - part.start})));
      candidates.sort((a, b) => a.width - b.width);
      return candidates.length ? {result, node: candidates[0].node} : null;
    };
    const enter = ev => {
      if (r.selecting || ev.buttons || r.aiSetupOpen) return;
      const trigger = ev.target.closest("[data-grammar-node],.source-unit"), panel = ev.target.closest(".inline-grammar:not([hidden])");
      if (panel) inspect(true);
      if (!r.grammarInspecting || !trigger || trigger.contains(ev.relatedTarget)) return;
      const pair = trigger.matches(".source-unit") ? sourceNode(trigger) : pairFor(trigger);
      if (!pair || samePair(preview, pair)) return;
      preview = pair;
      updateActive();
    };
    const leave = ev => {
      const trigger = ev.target.closest("[data-grammar-node],.source-unit");
      if (!trigger || trigger.contains(ev.relatedTarget)) return;
      preview = null;
      updateActive();
    };
    r.scope.on(article, "pointerover", enter);
    r.scope.on(article, "focusin", enter);
    r.scope.on(article, "pointerout", leave);
    r.scope.on(article, "focusout", leave);
    r.scope.on(document, "keydown", ev => {
      if (ev.key !== "Escape" || !r.grammarInspecting || r.aiSetupOpen) return;
      for (const panel of panels()) {
        const result = byId(panel.dataset.grammarResult);
        if (result) expanded.delete(result.anchor.block_id);
      }
      stopInspecting(); paint(); persist();
    });
    r.scope.cleanup(() => { ++locateEpoch; ++requestEpoch; r.grammarInspecting = false; clearPreview(); });
    paint();
  });
}
