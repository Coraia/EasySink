import { $, $$, e, local } from "../core.js";

export function install(ctx) {
  return ctx.hook("read", (r) => {
    const key = `grammar-open:${r.doc.id}:${r.doc.version}`;
    const expanded = new Set(local.get(key, [])),
      details = new Map(),
      branches = new Map();
    let pendingAnchor = null,
      locked = null;
    const chosenResults = new Map();
    const results = (block) =>
      r.assists.filter(
        (a) => a.kind === "grammar" && a.anchor.block_id === block,
      );
    const current = (block) =>
      results(block).find((a) => a.id === chosenResults.get(block)) ||
      results(block).at(-1);
    const paint = () => {
      if (r.scope.signal.aborted) return;
      $$("[data-grammar-block]").forEach((el) => {
        const id = el.dataset.grammarBlock,
          result = current(id),
          waiting = r.pending.has("grammar") && pendingAnchor?.block_id === id;
        const slot = $(
          `[data-grammar-slot="${id}"]`,
          el.closest(".source-fragment"),
        );
        slot.innerHTML = result
          ? `<button type="button" data-grammar-toggle="${id}" aria-expanded="${expanded.has(id)}" aria-label="${expanded.has(id) ? "收起" : "展开"}本段语法">${expanded.has(id) ? "−" : "+"}</button>`
          : "";
        el.hidden = !waiting && !(result && expanded.has(id));
        el.setAttribute("aria-busy", String(waiting));
        if (waiting) {
          el.innerHTML = '<div class="grammar-heading">正在分析完整句子…</div>';
          return;
        }
        if (!result || !expanded.has(id)) {
          el.replaceChildren();
          return;
        }
        const nodes = result.payload.nodes,
          root = nodes.find((n) => n.parent === null),
          active = nodes.find((n) => n.id === details.get(result.id)) || root;
        if (!branches.has(result.id))
          branches.set(
            result.id,
            new Set([
              root.id,
              ...nodes.filter((n) => n.parent === root.id).map((n) => n.id),
            ]),
          );
        const open = branches.get(result.id);
        const tree = (node) => {
          const children = nodes.filter((n) => n.parent === node.id);
          return `<div class="grammar-node-row">${children.length ? `<button type="button" data-grammar-branch="${e(node.id)}" data-result="${result.id}" aria-label="${open.has(node.id) ? "收起" : "展开"}${e(node.label)}" aria-expanded="${open.has(node.id)}">${open.has(node.id) ? "−" : "+"}</button>` : '<span class="grammar-spacer"></span>'}<button type="button" data-grammar-node="${e(node.id)}" data-result="${result.id}" aria-pressed="${active.id === node.id}">${e(node.label)}</button></div>${children.length ? `<div class="grammar-children" ${open.has(node.id) ? "" : "hidden"}>${children.map(tree).join("")}</div>` : ""}`;
        };
        el.innerHTML = `<div class="grammar-heading"><span>本段语法</span><button type="button" data-grammar-toggle="${id}">收起 −</button></div><div class="meta">${e(result.source)} · 完整句子</div><div class="grammar-tree">${tree(root)}</div><div class="grammar-detail" role="status"><p>${e(active === root ? result.payload.summary : active.explanation)}</p>${active !== root ? `<div class="grammar-quote">${active.ranges.map((v) => e(v.quote)).join("<br>↔<br>")}</div>` : ""}</div>`;
      });
    };
    const clearPreview = () => {
      $$("#article .source-unit").forEach((el) =>
        el.classList.remove("linked-grammar", "linked-reference"),
      );
    };
    const sourceNode = (unit) => {
      const result = current(unit.dataset.sourceBlock);
      if (!result || !expanded.has(unit.dataset.sourceBlock)) return null;
      const start = +unit.dataset.sourceStart,
        end = +unit.dataset.sourceEnd;
      const nodes = result.payload.nodes.filter((n) => n.parent !== null);
      let node = nodes
        .filter((n) => n.ranges[0].start <= start && n.ranges[0].end >= end)
        .sort(
          (a, b) =>
            a.ranges[0].end -
            a.ranges[0].start -
            (b.ranges[0].end - b.ranges[0].start),
        )[0];
      if (
        /^(that|which|since|because|and|but|it|so)$/i.test(unit.dataset.word)
      ) {
        const next = nodes
          .filter(
            (n) => n.ranges[0].start >= end && n.ranges[0].start - end <= 6,
          )
          .sort(
            (a, b) =>
              a.ranges[0].start - b.ranges[0].start ||
              b.ranges[0].end -
                b.ranges[0].start -
                (a.ranges[0].end - a.ranges[0].start),
          )[0];
        if (
          next &&
          (!node ||
            next.ranges[0].end - next.ranges[0].start <
              node.ranges[0].end - node.ranges[0].start)
        )
          node = next;
      }
      return node ? { result, node } : null;
    };
    const selectNode = (result, node, move = false) => {
      details.set(result.id, node.id);
      if (move) {
        r.pages.restore({ ...result.anchor, ...node.ranges[0] }, false);
        locked = { result, node };
      }
      paint();
      clearPreview();
      r.paintRanges(
        result.anchor,
        node.ranges,
        node.kind === "reference" ? "reference" : "grammar",
      );
    };
    r.selectionAction("grammar", "语法分析", async (anchor) => {
      if (r.pending.has("grammar")) {
        await r.requestAssist("grammar", anchor);
        pendingAnchor = null;
        paint();
        return;
      }
      const existing = results(anchor.block_id).find(
        (a) => a.anchor.start <= anchor.start && a.anchor.end >= anchor.end,
      );
      if (existing) {
        chosenResults.set(anchor.block_id, existing.id);
        expanded.add(anchor.block_id);
        paint();
        local.set(key, [...expanded]);
        return;
      }
      pendingAnchor = anchor;
      const result = await r.requestAssist("grammar", anchor);
      pendingAnchor = null;
      if (!result || r.scope.signal.aborted) return;
      chosenResults.set(result.anchor.block_id, result.id);
      expanded.add(result.anchor.block_id);
      paint();
      local.set(key, [...expanded]);
      r.status("语法已在原段落下方展开；翻译和笔记仍使用原选区。");
    });
    r.on("draw", () => {
      paint();
      if (locked)
        r.paintRanges(
          locked.result.anchor,
          locked.node.ranges,
          locked.node.kind === "reference" ? "reference" : "grammar",
        );
    });
    r.on("assist-change", paint);
    r.on("before-page", () => {
      locked = null;
    });
    r.scope.on($("#article"), "click", (ev) => {
      const toggle = ev.target.closest("[data-grammar-toggle]");
      if (toggle) {
        const id = toggle.dataset.grammarToggle;
        if (expanded.has(id)) expanded.delete(id);
        else expanded.add(id);
        locked = null;
        clearPreview();
        paint();
        local.set(key, [...expanded]);
        return;
      }
      const branch = ev.target.closest("[data-grammar-branch]");
      if (branch) {
        const open = branches.get(+branch.dataset.result);
        if (open.has(branch.dataset.grammarBranch))
          open.delete(branch.dataset.grammarBranch);
        else open.add(branch.dataset.grammarBranch);
        paint();
        return;
      }
      const node = ev.target.closest("[data-grammar-node]");
      if (node) {
        const result = r.assists.find((a) => a.id === +node.dataset.result);
        selectNode(
          result,
          result.payload.nodes.find((n) => n.id === node.dataset.grammarNode),
          true,
        );
      }
    });
    const preview = (ev) => {
      const trigger = ev.target.closest("[data-grammar-node],.source-unit");
      if (!trigger) return;
      let pair;
      if (trigger.matches(".source-unit")) pair = sourceNode(trigger);
      else {
        const result = r.assists.find((a) => a.id === +trigger.dataset.result);
        pair = {
          result,
          node: result.payload.nodes.find(
            (n) => n.id === trigger.dataset.grammarNode,
          ),
        };
      }
      if (!pair) return;
      const { result, node } = pair;
      clearPreview();
      r.paintRanges(
        result.anchor,
        node.ranges,
        node.kind === "reference" ? "reference" : "grammar",
      );
      const detail = $(
        `.inline-grammar[data-grammar-block="${result.anchor.block_id}"] .grammar-detail`,
      );
      if (detail) detail.innerHTML = `<p>${e(node.explanation)}</p>`;
    };
    const leave = (ev) => {
      const trigger = ev.target.closest("[data-grammar-node],.source-unit");
      if (!trigger || trigger.contains(ev.relatedTarget)) return;
      clearPreview();
      if (locked)
        r.paintRanges(
          locked.result.anchor,
          locked.node.ranges,
          locked.node.kind === "reference" ? "reference" : "grammar",
        );
    };
    r.scope.on($("#article"), "pointerover", preview);
    r.scope.on($("#article"), "focusin", preview);
    r.scope.on($("#article"), "pointerout", leave);
    r.scope.on($("#article"), "focusout", leave);
    paint();
  });
}
