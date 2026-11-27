import { anchorSegments, linkedRanges, rangeAnchor } from "../source-selection.js";
import { openReadingAI } from "../ai-setup-guard.js";
import { $, $$, api, e, local } from "../core.js";

const PREFETCH_CONCURRENCY = 3;
const WINDOW_OPTIONS = [
  [0, "当前页"],
  [1, "前后 1 页"],
  [2, "前后 2 页"],
];

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
    let modeOn = false, modeRun = null, lastWindowKey = "", hoverUnit = null;
    let windowPages = Number(local.get("grammar-mode-window", 1));
    if (![0, 1, 2].includes(windowPages)) windowPages = 1;
    r.grammarInspecting = false;
    const results = (block) => r.assists.filter(a => a.kind === "grammar" && a.anchor.block_id === block);
    const current = (block) => results(block).find(a => a.id === chosenResults.get(block)) || results(block).at(-1);
    const byId = (id) => r.assists.find(a => a.kind === "grammar" && String(a.id) === String(id));
    const panels = () => $$(".inline-grammar:not([hidden])", article);
    const persist = () => local.set(key, [...expanded]);
    const rootOf = result => result.payload.nodes.find(n => n.parent === null);
    const nodeOwnRanges = (result, node) => {
      if (!node.target_ranges?.length && node.kind === "reference" && node.ranges.length >= 2)
        return linkedRanges(result.anchor, [node.ranges[0]]);
      return linkedRanges(result.anchor, node.ranges);
    };
    const nodeTargetRanges = (result, node) => {
      if (node.role === "formal_it") return [];
      if (Array.isArray(node.target_ranges) && node.target_ranges.length)
        return linkedRanges(result.anchor, node.target_ranges);
      if (node.kind === "reference" && node.ranges.length >= 2)
        return linkedRanges(result.anchor, node.ranges.slice(1));
      return [];
    };
    const paintHighlightRanges = (ranges, name, priority) => {
      if (!globalThis.CSS?.highlights || !globalThis.Highlight || !ranges.length) return;
      const marked = [];
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
        mark.priority = priority;
        CSS.highlights.set(name, mark);
      }
    };
    const clearPreview = () => {
      $$(".source-unit", article).forEach(el =>
        el.classList.remove("linked-grammar", "linked-reference", "linked-grammar-target"));
      globalThis.CSS?.highlights?.delete("reader-grammar");
      globalThis.CSS?.highlights?.delete("reader-grammar-target");
    };
    const inspect = (on) => {
      if (r.grammarInspecting === on) return;
      r.grammarInspecting = on;
      if (on) getSelection()?.removeAllRanges();
      r.positionSelection();
    };
    const highlight = (pair) => {
      clearPreview();
      if (!pair || (!r.grammarInspecting && !modeOn)) return;
      const {result, node} = pair;
      const own = nodeOwnRanges(result, node);
      const targets = nodeTargetRanges(result, node);
      const highlightOwn = modeOn ? own : linkedRanges(result.anchor, node.ranges);
      r.paintRanges(result.anchor, highlightOwn, node.kind === "reference" ? "reference" : "grammar");
      paintHighlightRanges(highlightOwn, "reader-grammar", 3);
      if (targets.length) {
        $$(".source-unit", article).forEach(el =>
          el.classList.toggle("linked-grammar-target", targets.some(v =>
            el.dataset.sourceBlock === v.block_id &&
            +el.dataset.sourceStart < v.end && +el.dataset.sourceEnd > v.start)));
        paintHighlightRanges(targets, "reader-grammar-target", 4);
      }
    };
    const pairFor = (el) => {
      const result = byId(el?.dataset.result);
      const node = result?.payload.nodes.find(n => n.id === el.dataset.grammarNode);
      return node ? {result, node} : null;
    };
    const samePair = (a, b) => a?.result.id === b?.result.id && a?.node.id === b?.node.id;

    // Grammar analysis mode controls (one-click toggle + window selector in caption bar)
    const readerEl = $(".reader");
    const hoverCard = document.createElement("div");
    hoverCard.className = "grammar-hover-card";
    hoverCard.hidden = true;
    hoverCard.setAttribute("role", "tooltip");
    readerEl?.append(hoverCard);

    const modeBar = document.createElement("div");
    modeBar.className = "grammar-mode-bar";
    modeBar.dataset.grammarModeBar = "";
    modeBar.innerHTML = `<button type="button" class="grammar-mode-toggle" data-grammar-mode-toggle aria-pressed="false" title="开启后后台分析窗口内句子，悬停原文即可查看从句修饰与 it/that/which 回指"><span class="grammar-mode-dot" aria-hidden="true"></span><span>语法模式</span></button><select class="grammar-window-select" data-grammar-window aria-label="语法分析范围" hidden>${WINDOW_OPTIONS.map(([v, label]) => `<option value="${v}" ${v === windowPages ? "selected" : ""}>${label}</option>`).join("")}</select><span class="grammar-mode-status" data-grammar-mode-status hidden></span>`;
    $(".reader-page-caption .caption-end")?.prepend(modeBar);

    const modeToggleBtn = $("[data-grammar-mode-toggle]", modeBar);
    const modeWindowSelect = $("[data-grammar-window]", modeBar);
    const modeStatusEl = $("[data-grammar-mode-status]", modeBar);

    const hideHoverCard = () => {
      hoverUnit = null;
      hoverCard.hidden = true;
    };
    const showHoverCard = (pair, unit) => {
      if (!modeOn || !pair || !unit) { hideHoverCard(); return; }
      const {result, node} = pair;
      const own = nodeOwnRanges(result, node);
      const targets = nodeTargetRanges(result, node);
      const ownQuote = own.map(v => v.quote).filter(Boolean).join(" … ");
      const targetQuote = targets.map(v => v.quote).filter(Boolean).join(" · ");
      const badge = node.role === "formal_it" ? "形式主语"
        : node.kind === "reference" || node.role === "referential" ? "代词回指"
        : node.role === "clause_modifier" || targets.length ? "从句修饰"
        : "语法结构";
      let targetHtml = "";
      if (node.role === "formal_it") {
        targetHtml = `<div class="grammar-hover-target is-formal">形式主语，无先行词</div>`;
      } else if (targetQuote) {
        const label = node.kind === "reference" || node.role === "referential" ? "回指先行词" : "修饰对象";
        targetHtml = `<div class="grammar-hover-target"><span class="grammar-hover-key">${label}</span><span class="grammar-hover-quote" lang="en">${e(targetQuote)}</span></div>`;
      } else if (node.kind === "reference") {
        targetHtml = `<div class="grammar-hover-target is-uncertain">未确定先行词（仅标出代词本身）</div>`;
      }
      hoverCard.innerHTML = `<div class="grammar-hover-head"><span class="grammar-hover-badge">${badge}</span><span class="grammar-hover-label">${e(node.label)}</span></div>${ownQuote ? `<div class="grammar-hover-source" lang="en">${e(ownQuote)}</div>` : ""}${targetHtml}<p class="grammar-hover-explanation">${e(node.explanation)}</p>`;
      hoverCard.hidden = false;
      const rect = unit.getBoundingClientRect();
      const box = hoverCard.getBoundingClientRect();
      const gap = 10;
      const left = Math.max(12, Math.min(rect.left + rect.width / 2 - box.width / 2, innerWidth - box.width - 12));
      const above = rect.top - gap - box.height >= 12;
      const top = above
        ? rect.top - box.height - gap
        : Math.min(innerHeight - box.height - 12, rect.bottom + gap);
      hoverCard.style.left = `${left}px`;
      hoverCard.style.top = `${Math.max(12, top)}px`;
    };

    const setModeStatus = (text, title = "") => {
      modeStatusEl.textContent = text;
      modeStatusEl.title = title;
      modeStatusEl.hidden = !modeOn || !text;
    };
    const updateModeUI = () => {
      modeToggleBtn.setAttribute("aria-pressed", String(modeOn));
      modeToggleBtn.classList.toggle("is-active", modeOn);
      modeWindowSelect.hidden = !modeOn;
      readerEl?.classList.toggle("grammar-mode-active", modeOn);
      if (!modeOn) {
        modeStatusEl.hidden = true;
        modeStatusEl.textContent = "";
      }
    };
    const cancelModeRun = () => {
      if (!modeRun) return;
      const run = modeRun;
      modeRun = null;
      run.controller.abort();
      for (const req of run.inflight) req.cancel();
      run.inflight.clear();
    };
    const stopMode = () => {
      modeOn = false;
      lastWindowKey = "";
      cancelModeRun();
      hideHoverCard();
      if (!panels().length) {
        preview = null;
        clearPreview();
      }
      updateModeUI();
    };
    const windowBlockIds = () => {
      const pages = r.pages?.pages || [];
      if (!pages.length) {
        return [...new Set($$("[data-block]", article).map(el => el.dataset.block).filter(Boolean))];
      }
      const start = Math.max(0, r.pages.index || 0);
      const spread = Math.max(1, r.pages.count || 1);
      const visibleEnd = Math.min(pages.length - 1, start + spread - 1);
      const order = [];
      for (let i = start; i <= visibleEnd; i++) order.push(i);
      for (let d = 1; d <= windowPages; d++) {
        if (visibleEnd + d < pages.length) order.push(visibleEnd + d);
        if (start - d >= 0) order.push(start - d);
      }
      const seen = new Set(), ids = [];
      for (const pageIdx of order) {
        for (const fragment of pages[pageIdx] || []) {
          if (fragment.id && !seen.has(fragment.id)) {
            seen.add(fragment.id);
            ids.push(fragment.id);
          }
        }
      }
      return ids;
    };
    const hasCachedAssist = (anchor) => r.assists.some(a =>
      a.kind === "grammar" &&
      a.anchor.block_id === anchor.block_id &&
      a.anchor.start <= anchor.start &&
      a.anchor.end >= anchor.end);
    const syncModeWindow = async (force = false) => {
      if (!modeOn || r.scope.signal.aborted) return;
      const blockIds = windowBlockIds();
      const windowKey = `${windowPages}:${blockIds.join(",")}`;
      if (!force && windowKey === lastWindowKey) return;
      lastWindowKey = windowKey;
      cancelModeRun();
      const run = { controller: new AbortController(), inflight: new Set(), done: 0, total: 0, cached: 0, failed: 0 };
      modeRun = run;
      setModeStatus("规划中…");
      let plan;
      try {
        plan = await api(`/documents/${r.doc.id}/grammar/plan`, {
          method: "POST",
          body: { block_ids: blockIds },
          signal: run.controller.signal,
        });
      } catch (err) {
        if (err.name === "AbortError" || modeRun !== run || r.scope.signal.aborted) return;
        r.status(err.message, { notice: true });
        stopMode();
        return;
      }
      if (run.controller.signal.aborted || modeRun !== run || r.scope.signal.aborted) return;
      run.total = plan.total_count;
      run.cached = plan.cached_count;
      run.done = plan.cached_count;
      if (!plan.total_count) {
        setModeStatus("当前窗口无可分析句子");
        return;
      }
      if (!plan.provider_available && plan.uncached_count > 0) {
        if (plan.cached_count === 0) {
          stopMode();
          openReadingAI(r, { anchor: plan.sentences[0]?.anchor, kind: "grammar" })
            .catch(err => r.status(err.message, { notice: true }));
          return;
        }
        setModeStatus(`已缓存 ${plan.cached_count}/${plan.total_count}`, "未配置文本 AI，仅悬停查看已缓存句子");
        return;
      }
      const uncached = plan.sentences.filter(s => !s.cached && !hasCachedAssist(s.anchor));
      run.done = run.total - uncached.length;
      const windowDesc = windowPages === 0 ? "当前页" : `前后 ${windowPages} 页`;
      const planTitle = `窗口：${windowDesc} · 本次约 ${uncached.length} 次调用（已缓存 ${run.done} 句）`;
      if (!uncached.length) {
        setModeStatus(`已就绪 ${run.total}/${run.total}`, planTitle);
        return;
      }
      setModeStatus(`分析中 ${run.done}/${run.total}`, planTitle);
      let cursor = 0;
      const worker = async () => {
        while (cursor < uncached.length) {
          if (run.controller.signal.aborted || !modeOn || modeRun !== run || r.scope.signal.aborted) return;
          const item = uncached[cursor++];
          if (hasCachedAssist(item.anchor)) {
            run.done++;
            setModeStatus(`分析中 ${run.done}/${run.total}`, planTitle);
            continue;
          }
          const req = r.assistController(r.doc.id);
          run.inflight.add(req);
          try {
            const result = await api(`/documents/${r.doc.id}/grammar`, {
              method: "POST",
              body: { anchor: item.anchor, request_id: req.requestId },
              signal: req.signal,
            });
            if (req.signal.aborted || run.controller.signal.aborted || !modeOn || modeRun !== run || r.scope.signal.aborted) return;
            const index = r.assists.findIndex(a => a.id === result.id);
            if (index < 0) r.assists.push(result);
            else r.assists[index] = result;
            run.done++;
            setModeStatus(run.done < run.total ? `分析中 ${run.done}/${run.total}` : `已就绪 ${run.done}/${run.total}`, planTitle);
            if (hoverUnit && hoverUnit.isConnected) {
              const pair = sourceNode(hoverUnit);
              if (pair) { preview = pair; highlight(pair); showHoverCard(pair, hoverUnit); }
            }
          } catch (err) {
            if (err.name === "AbortError" || req.signal.aborted || run.controller.signal.aborted || modeRun !== run) return;
            if ([400, 401, 403, 503].includes(err.status)) {
              r.status(err.message, { notice: true });
              stopMode();
              return;
            }
            run.failed++;
          } finally {
            run.inflight.delete(req);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(PREFETCH_CONCURRENCY, uncached.length) }, worker));
      if (run.controller.signal.aborted || !modeOn || modeRun !== run || r.scope.signal.aborted) return;
      if (run.failed > 0) setModeStatus(`完成 ${run.done}/${run.total}（${run.failed} 失败）`, planTitle);
      else setModeStatus(`已就绪 ${run.done}/${run.total}`, planTitle);
    };

    r.scope.on(modeToggleBtn, "click", () => {
      if (modeOn) { stopMode(); return; }
      modeOn = true;
      updateModeUI();
      syncModeWindow(true);
    });
    r.scope.on(modeWindowSelect, "change", () => {
      const next = Number(modeWindowSelect.value);
      if (![0, 1, 2].includes(next)) return;
      windowPages = next;
      local.set("grammar-mode-window", windowPages);
      if (modeOn) syncModeWindow(true);
    });

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
      hideHoverCard();
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
      if (modeOn) syncModeWindow(false);
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
    r.on("before-navigation", () => { ++locateEpoch; hideHoverCard(); });
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
    const bestNodeIn = (result, unit) => {
      const start = +unit.dataset.sourceStart, end = +unit.dataset.sourceEnd;
      const candidates = result.payload.nodes.filter(n => n.parent !== null).flatMap(node =>
        nodeOwnRanges(result, node).filter(p => p.block_id === unit.dataset.sourceBlock && p.start <= start && p.end >= end)
          .map(part => {
            const isRef = node.kind === "reference" || node.role === "formal_it" || node.role === "referential";
            const hasTarget = nodeTargetRanges(result, node).length > 0;
            return { node, width: part.end - part.start, rank: isRef ? 0 : hasTarget ? 1 : 2 };
          }));
      candidates.sort((a, b) => a.width - b.width || a.rank - b.rank);
      return candidates.length ? { result, node: candidates[0].node } : null;
    };
    const sourceNode = (unit) => {
      const panelResult = panels().map(el => byId(el.dataset.grammarResult)).find(value => value &&
        anchorSegments(value.anchor).some(p => p.block_id === unit.dataset.sourceBlock));
      if (panelResult) {
        const hit = bestNodeIn(panelResult, unit);
        return hit ? { ...hit, fromPanel: true } : null;
      }
      if (!modeOn) return null;
      const start = +unit.dataset.sourceStart, end = +unit.dataset.sourceEnd;
      const candidates = r.assists.filter(a => a.kind === "grammar" &&
        anchorSegments(a.anchor).some(p => p.block_id === unit.dataset.sourceBlock && p.start <= start && p.end >= end));
      for (const result of candidates) {
        const hit = bestNodeIn(result, unit);
        if (hit) return { ...hit, fromPanel: false };
      }
      return null;
    };
    const enter = ev => {
      if (r.selecting || ev.buttons || r.aiSetupOpen) return;
      const trigger = ev.target.closest("[data-grammar-node],.source-unit"), panel = ev.target.closest(".inline-grammar:not([hidden])");
      if (panel) inspect(true);
      if ((!r.grammarInspecting && !modeOn) || !trigger || trigger.contains(ev.relatedTarget)) return;
      if (trigger.matches(".source-unit")) {
        hoverUnit = trigger;
        const found = sourceNode(trigger);
        if (!found || !found.node) { hideHoverCard(); return; }
        const pair = { result: found.result, node: found.node };
        if (!samePair(preview, pair)) {
          preview = pair;
          updateActive();
        }
        if (modeOn && !found.fromPanel) showHoverCard(pair, trigger);
        else hideHoverCard();
        return;
      }
      hideHoverCard();
      const pair = pairFor(trigger);
      if (!pair || samePair(preview, pair)) return;
      preview = pair;
      updateActive();
    };
    const leave = ev => {
      const trigger = ev.target.closest("[data-grammar-node],.source-unit");
      if (!trigger || trigger.contains(ev.relatedTarget)) return;
      preview = null;
      hideHoverCard();
      updateActive();
    };
    r.scope.on(article, "pointerover", enter);
    r.scope.on(article, "focusin", enter);
    r.scope.on(article, "pointerout", leave);
    r.scope.on(article, "focusout", leave);
    r.scope.on(document, "keydown", ev => {
      if (ev.key !== "Escape" || r.aiSetupOpen) return;
      if (r.grammarInspecting) {
        for (const panel of panels()) {
          const result = byId(panel.dataset.grammarResult);
          if (result) expanded.delete(result.anchor.block_id);
        }
        stopInspecting(); paint(); persist();
      } else if (modeOn && (preview || !hoverCard.hidden)) {
        preview = null;
        hideHoverCard();
        clearPreview();
      }
    });
    r.scope.cleanup(() => {
      ++locateEpoch;
      ++requestEpoch;
      stopMode();
      modeBar.remove();
      hoverCard.remove();
      r.grammarInspecting = false;
      clearPreview();
    });
    paint();
  });
}
