import { linkedRanges, rangeAnchor } from "../source-selection.js";
import { $, $$, e } from "../core.js";

export function install(ctx) {
  return ctx.hook("read", (r) => {
    let result = null,
      locked = null,
      navigation = 0;
    const pane = $("#translation-pane");
    const paint = () => {
      if (!result) return;
      pane.hidden = false;
      $(".reading-columns").classList.add("has-translation");
      pane.innerHTML = `<div class="translation-heading"><h2>所选文字 · 对照</h2><button type="button" data-close-translation aria-label="收起对照译文">×</button></div><div class="meta">${e(result.source)}</div><div class="translation-segments">${result.payload.segments.map((v, i) => `<button type="button" class="translation-segment" data-pair="${i}" aria-label="定位对应原文：${e(v.zh)}">${e(v.zh)}</button>`).join("")}</div><div class="translation-actions"><button type="button" data-return-translation>回到选区</button>${ctx.enabled("notes") ? '<button type="button" data-translation-note>记一笔</button>' : ""}</div>`;
    };
    r.showTranslation = (value) => {
      ++navigation;
      locked = null;
      r.cancelHighlight();
      result = value;
      paint();
      r.pages.reflow(r.position());
      r.status("对照译文已就位，原文位置保持。");
    };
    const translate = async (anchor) => {
      const value = await r.requestAssist("translation", anchor);
      if (value && !r.scope.signal.aborted) r.showTranslation(value);
    };
    r.selectionAction("translation", "翻译所选文字", translate);
    r.tool("translate", "选区翻译", () => {
      if (r.selection) translate({ ...r.selection });
      else r.status("请在原文选择文字，或点击段落下的“选择这一段”。");
    });
    const highlight = (i) => {
      if (!result) return;
      const range = result.payload.segments[i];
      r.paintRanges(result.anchor, range ? [range] : []);
      $$("[data-pair]", pane).forEach((el) => {
        const active = +el.dataset.pair === i;
        el.classList.toggle("active", active);
        el.setAttribute("aria-current", String(active));
      });
    };
    r.scope.on(pane, "pointerover", (ev) => {
      const b = ev.target.closest("[data-pair]");
      if (b) highlight(+b.dataset.pair);
    });
    r.scope.on(pane, "focusin", (ev) => {
      const b = ev.target.closest("[data-pair]");
      if (b) highlight(+b.dataset.pair);
    });
    r.scope.on(pane, "pointerout", (ev) => {
      const pair = ev.target.closest("[data-pair]");
      if (!pair || pair.contains(ev.relatedTarget)) return;
      highlight(locked);
    });
    r.scope.on(pane, "click", async (ev) => {
      const b = ev.target.closest("[data-pair]");
      if (b) {
        const value = result, pair = +b.dataset.pair, token = ++navigation;
        const restored = await r.restore(rangeAnchor(value.anchor, value.payload.segments[pair]), {mark: false});
        if (!restored || r.scope.signal.aborted || result !== value || token !== navigation) return;
        locked = pair;
        highlight(pair);
        return;
      }
      if (ev.target.closest("[data-close-translation]")) {
        ++navigation;
        highlight(null);
        pane.hidden = true;
        $(".reading-columns").classList.remove("has-translation");
        result = null;
        locked = null;
        r.pages.reflow(r.position());
        return;
      }
      if (ev.target.closest("[data-return-translation]")) {
        ++navigation;
        locked = null;
        highlight(null);
        r.restore(result.anchor);
      }
      if (ev.target.closest("[data-translation-note]")) {
        r.choose(result.anchor);
        r.selectionActions.get("notes")?.fn(result.anchor);
      }
    });
    r.scope.on($("#article"), "pointerover", (ev) => {
      const word = ev.target.closest("[data-source-start]");
      if (
        !word ||
        !result
      )
        return;
      const i = result.payload.segments.findIndex(
        (v) => linkedRanges(result.anchor, [v]).some(part =>
          word.dataset.sourceBlock === part.block_id &&
          +word.dataset.sourceStart < part.end && +word.dataset.sourceEnd > part.start),
      );
      if (i >= 0) highlight(i);
    });
    r.scope.on($("#article"), "pointerout", (ev) => {
      const word = ev.target.closest("[data-source-start]");
      if (word && !word.contains(ev.relatedTarget)) highlight(locked);
    });
    r.on("draw", () => {
      if (locked !== null) highlight(locked);
    });
    r.on("before-page", (ev) => {
      // Repagination preserves the same source anchor; only navigation clears
      // the pinned sentence. The next draw repaints its visible text ranges.
      if (ev.detail?.reflow) return;
      locked = null;
      highlight(null);
    });
    r.on("before-selection", () => {
      ++navigation;
      locked = null;
      highlight(null);
    });
    r.scope.on(document, "keydown", (ev) => {
      if (ev.key !== "Escape") return;
      ++navigation;
      locked = null;
      highlight(null);
    });
  });
}
