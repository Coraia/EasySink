import { $, e, toast } from "./core.js";
import { sameSelection } from "./source-selection.js";
import { childScope } from "./collections-store.js";
import { editCollection } from "./collections-dialogs.js";
import { adoptedAt } from "./collections-context.js";

export function mountCollectionWord(
  ctx,
  store,
  { reader, pop, item, anchor, scope: parentScope },
) {
  const controller = reader.collectionsController;
  if (!controller || !anchor || anchor.kind === "image") return;
  const scope = childScope(store.scope, parentScope, reader.scope);
  const old = [...pop.querySelectorAll("[data-verdict]")].map((node) => ({
    node,
    hidden: node.hidden,
  }));
  old.forEach(({ node }) => {
    node.hidden = true;
  });
  const currentMeaning = document.createElement("section");
  currentMeaning.className = "collections-current-meaning";
  $("h3", pop).after(currentMeaning);
  const section = document.createElement("section");
  section.className = "collections-word";
  section.innerHTML =
    '<div class="collections-independent" role="group" aria-label="此处的独立阅读记录"><button type="button" data-collection-word>收藏词语</button><button type="button" data-understood>已掌握</button><button type="button" data-retained>保留注释</button></div><p class="collections-help">只记录这一次用法；收藏、掌握反馈和保留注释各自独立。</p><p class="collections-status" role="status"></p><div class="collections-actions"><button type="button" data-word-edit hidden>我的释义 / 已存解释</button><button type="button" data-state-retry hidden>重新加载记录</button></div>';
  const meaning = $(".meaning", pop),
    detail = meaning?.nextElementSibling?.matches("p.muted")
      ? meaning.nextElementSibling
      : null;
  ($(".dictionary-candidates", pop) || meaning || $("h3", pop)).after(
    section,
  );
  let busy = false,
    saved = null,
    feedback = null,
    suppressedMeaning = null;
  const status = $("[role=status]", section);
  const render = () => {
    if (scope.signal.aborted) return;
    saved = controller.state.items.find(
      (value) => value.kind === "word" && sameSelection(value.anchor, anchor),
    );
    feedback = controller.state.feedback.find((value) =>
      sameSelection(value.anchor, anchor),
    );
    const adopted = adoptedAt(controller.state, anchor);
    pop.adoptedContext = adopted;
    currentMeaning.hidden = !adopted;
    currentMeaning.innerHTML = adopted ? `<p class="collections-source">此处释义 · 已采用</p><p class="collections-adopted-gloss">${e(adopted.payload.meaning)}</p><p>${e(adopted.payload.explanation || "")}</p>` : "";
    // Keep the source dictionary available, but never show a stale gloss as
    // the occurrence's primary meaning after a live adoption.
    if (adopted) {
      suppressedMeaning ??= { meaning: meaning?.hidden, detail: detail?.hidden };
      if (meaning) meaning.hidden = true;
      if (detail) detail.hidden = true;
    } else if (suppressedMeaning) {
      if (meaning) meaning.hidden = suppressedMeaning.meaning;
      if (detail) detail.hidden = suppressedMeaning.detail;
      suppressedMeaning = null;
      // A dictionary may have arrived while the adopted gloss was visible.
      reader.renderDictionary?.(pop, item);
    }
    for (const [selector, active, label] of [
      [
        "[data-collection-word]",
        Boolean(saved),
        saved ? "已收藏词语 ✓" : "收藏词语",
      ],
      [
        "[data-understood]",
        feedback?.understood === true,
        feedback?.understood === true ? "已掌握 ✓" : "已掌握",
      ],
      [
        "[data-retained]",
        Boolean(feedback?.retained),
        feedback?.retained ? "已保留注释 ✓" : "保留注释",
      ],
    ]) {
      const button = $(selector, section);
      button.textContent = label;
      button.setAttribute("aria-pressed", String(active));
      button.disabled = busy || !controller.loaded;
    }
    $("[data-word-edit]", section).hidden = !saved;
    $("[data-state-retry]", section).hidden = !controller.error;
    if (!busy)
      status.textContent = controller.error
        ? `记录未能加载：${controller.error.message}`
        : "";
  };
  scope.on(section, "click", async (event) => {
    const button = event.target.closest(
      "[data-collection-word],[data-understood],[data-retained],[data-word-edit],[data-state-retry]",
    );
    if (!button || button.disabled || busy) return;
    if (button.hasAttribute("data-word-edit")) {
      if (saved) {
        reader.closePop();
        editCollection(ctx, store, saved, reader.scope);
      }
      return;
    }
    busy = true;
    render();
    status.textContent = "正在保存…";
    try {
      if (button.hasAttribute("data-state-retry")) await controller.reload();
      else if (button.hasAttribute("data-collection-word")) {
        const senses = item.dictionary?.senses || [];
        const text = senses.length
          ? senses
              .map(
                (sense) =>
                  sense.raw ||
                  [sense.pos, ...(sense.labels || []), sense.text]
                    .filter(Boolean)
                    .join(" "),
              )
              .join("\n")
          : item.note;
        const source = item.dictionary?.source?.name || item.source || "词典";
        // Only dictionary/gloss text is saved here. A cached AI result still
        // requires the explicit preview/adopt action.
        const explanation =
          text && item.source !== "model"
            ? {
                text,
                source,
                kind:
                  item.dictionary || item.source === "dictionary"
                    ? "dictionary"
                    : "gloss",
              }
            : undefined;
        const result = saved
          ? await store.remove(saved)
          : await store.write("", {
              doc_id: reader.doc.id,
              kind: "word",
              anchor,
              ...(explanation ? { explanation } : {}),
            });
        store.undo(
          result,
          saved
            ? "已取消这次词语收藏；独立笔记仍保留"
            : "已收藏这次词语与原文语境",
        );
        await controller.reload();
      } else {
        let fields, message;
        if (button.hasAttribute("data-understood")) {
          const understood = feedback?.understood === true ? null : true;
          fields = { understood };
          message = understood ? "已记录：已掌握这里的用法" : "已回到未反馈状态";
        } else {
          const retained = !feedback?.retained;
          const adopted = adoptedAt(controller.state, anchor);
          const note =
            adopted?.payload.meaning || item.note ||
            item.dictionary?.senses?.find((sense) => sense.language === "zh")
              ?.text ||
            item.dictionary?.senses?.[0]?.text;
          if (retained && !note)
            throw new Error("这里尚无可保留的注释，请先取得可用释义。");
          fields = {
            retained,
            ...(retained
              ? {
                  note,
                  detail: adopted?.payload.explanation || item.detail || "",
                  target: item.target || anchor.quote,
                }
              : {}),
          };
          message = retained ? "已在这里保留注释" : "已取消这里的显式保留";
        }
        const result = await store.write("/feedback", {
          doc_id: reader.doc.id,
          anchor,
          ...fields,
        });
        store.undo(result, message);
        await controller.reload();
      }
    } catch (error) {
      if (!scope.signal.aborted) toast(error.message);
    } finally {
      busy = false;
      render();
    }
  });
  pop.adoptContext = async (record) => {
    if (!controller.loaded) throw new Error("阅读记录尚未就绪，请先重新加载记录。");
    if (!record || !sameSelection(record.anchor, anchor)) throw new Error("解释与当前原文位置不一致。");
    const existing = controller.state.items.find(value => value.kind === "word" && sameSelection(value.anchor, anchor));
    const result = existing ? await store.write(`/${encodeURIComponent(existing.id)}`,
      { adopt_assist_id: record.id, expected_revision: existing.revision }, "PATCH") :
      await store.write("/adopt", { doc_id: reader.doc.id, anchor, adopt_assist_id: record.id,
        expected_collection_revision: 0,
        expected_feedback_revision: controller.state.feedback.find(value => sameSelection(value.anchor, anchor))?.revision || 0 });
    store.undo(result, "已用于此处释义；其他位置不变");
    await controller.reload();
  };
  scope.on(controller.events, "state", () => {
    render();
    pop.dispatchEvent(new Event("context-adoption-change"));
  });
  scope.on(reader.events, "assist-change", render);
  scope.on(reader.events, "context-record", (event) => {
    if (event.detail?.pop === pop) render();
  });
  // Parent may attach the structured lookup payload after the pop is mounted.
  scope.on(reader.events, "dictionary-record", (event) => {
    if (event.detail?.pop === pop) render();
  });
  scope.cleanup(() => {
    old.forEach(({ node, hidden }) => {
      node.hidden = hidden;
    });
    section.remove();
    currentMeaning.remove();
    delete pop.adoptContext;
  });
  render();
  return scope;
}
