import { $, $$, e } from "../core.js";

export function install(ctx) {
  return ctx.hook("read", (r) => {
    let result = null,
      locked = null;
    const pane = $("#translation-pane");
    const paint = () => {
      if (!result) return;
      pane.hidden = false;
      $(".reading-columns").classList.add("has-translation");
      pane.innerHTML = `<div class="translation-heading"><h2>所选文字 · 对照</h2><button type="button" data-close-translation aria-label="收起对照译文">×</button></div><div class="meta">${e(result.source)}</div><div class="translation-segments">${result.payload.segments.map((v, i) => `<button type="button" class="translation-segment" data-pair="${i}" aria-label="定位对应原文：${e(v.zh)}">${e(v.zh)}</button>`).join("")}</div><div class="translation-actions"><button type="button" data-return-translation>回到选区</button>${ctx.enabled("notes") ? '<button type="button" data-translation-note>记一笔</button>' : ""}</div>`;
    };
    r.showTranslation = (value) => {
      result = value;
      paint();
      r.pages.reflow(r.position());
      r.status("译文已在右侧就位，原文位置保持。");
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
      r.paintRanges(result.anchor, [range]);
      $$("[data-pair]", pane).forEach((el) =>
        el.classList.toggle("active", +el.dataset.pair === i),
      );
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
      if (!ev.target.closest("[data-pair]")) return;
      r.paintRanges(result.anchor, []);
      if (locked !== null) highlight(locked);
    });
    r.scope.on(pane, "click", (ev) => {
      const b = ev.target.closest("[data-pair]");
      if (b) {
        locked = +b.dataset.pair;
        r.restore({ ...result.anchor, ...result.payload.segments[locked] });
        highlight(locked);
        return;
      }
      if (ev.target.closest("[data-close-translation]")) {
        pane.hidden = true;
        $(".reading-columns").classList.remove("has-translation");
        result = null;
        locked = null;
        r.pages.reflow(r.position());
        return;
      }
      if (ev.target.closest("[data-return-translation]"))
        r.restore(result.anchor);
      if (ev.target.closest("[data-translation-note]")) {
        r.choose(result.anchor);
        r.selectionActions.get("notes")?.fn(result.anchor);
      }
    });
    r.scope.on($("#article"), "pointerover", (ev) => {
      const word = ev.target.closest("[data-source-start]");
      if (
        !word ||
        !result ||
        word.dataset.sourceBlock !== result.anchor.block_id
      )
        return;
      const i = result.payload.segments.findIndex(
        (v) =>
          +word.dataset.sourceStart < v.end &&
          +word.dataset.sourceEnd > v.start,
      );
      if (i >= 0) highlight(i);
    });
    r.on("draw", () => {
      if (locked !== null) highlight(locked);
    });
    r.on("before-page", () => {
      locked = null;
    });
  });
}
