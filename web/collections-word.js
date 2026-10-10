import { $, e, toast } from "./core.js";
import { sameSelection } from "./source-selection.js";
import { childScope } from "./collections-store.js";
import { editCollection } from "./collections-dialogs.js";

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
  const section = document.createElement("section");
  section.className = "collections-word";
  section.innerHTML =
    '<div class="collections-independent" role="group" aria-label="此处的独立阅读记录"><button type="button" data-collection-word>收藏词语</button><button type="button" data-understood>已懂这里</button><button type="button" data-retained>保留注释</button></div><p class="collections-help">只记录这一次用法；收藏、理解和保留注释各自独立。</p><p class="collections-status" role="status"></p><div class="collections-actions"><button type="button" data-word-edit hidden>我的释义 / 已存解释</button><button type="button" data-word-adopt hidden>预览并采用解释</button><button type="button" data-state-retry hidden>重新加载记录</button></div>';
  const dictionary = document.createElement("section");
  dictionary.className = "collections-dictionary";
  const meaning = $(".meaning", pop),
    detail = meaning?.nextElementSibling?.matches("p.muted")
      ? meaning.nextElementSibling
      : null;
  const originalMeaningHidden = meaning?.hidden,
    originalDetailHidden = detail?.hidden;
  ($(".dictionary-candidates", pop) || meaning || $("h3", pop)).after(
    dictionary,
    section,
  );
  let busy = false,
    candidate = null,
    saved = null,
    feedback = null,
    lastDictionary = null,
    managedDictionary = false;
  const status = $("[role=status]", section);
  const renderDictionary = () => {
    if (reader.renderDictionary) {
      dictionary.hidden = true;
      return;
    }
    const value = item.dictionary;
    if (!value || value === lastDictionary) return;
    lastDictionary = value;
    managedDictionary = true;
    const senses = value.senses || [];
    const source =
      value.source?.name ||
      (typeof value.source === "string" ? value.source : "词典");
    dictionary.innerHTML = `<p class="collections-source">${e(source)} · 通用释义候选</p>${value.chinese_missing ? `<p class="collections-help">${senses.some((sense) => sense.language === "en") ? "可靠中文释义暂缺，先提供已有英文。" : "这项词条暂无可用释义。"}</p>` : ""}${senses.map((sense) => `<div class="collections-sense"><span class="collections-sense-meta">${e([sense.pos, ...(sense.labels || sense.domains || []), sense.language === "en" ? "英文候选" : ""].filter(Boolean).join(" · "))}</span><p lang="${sense.language === "en" ? "en" : "zh"}">${e(sense.text || sense.raw)}</p></div>`).join("")}<p class="collections-help">这些义项尚未确定在当前句子中的含义。</p><details><summary>词典来源</summary><p class="collections-source">${e(source)}${value.source?.version ? ` · ${e(value.source.version)}` : ""}${value.source?.license ? ` · ${e(value.source.license)}` : ""}</p></details>`;
    if (meaning) meaning.hidden = true;
    if (detail) detail.hidden = true;
  };
  const members = [
    ...(anchor.quote || "").matchAll(
      /[A-Za-z\uFB00-\uFB06]+(?:['’-][A-Za-z\uFB00-\uFB06]+)*/g,
    ),
  ];
  if (
    !reader.renderDictionary &&
    members.length > 1 &&
    !anchor.segments?.length
  ) {
    const actions = document.createElement("div");
    actions.className = "collections-members";
    actions.innerHTML = `<span class="collections-source">也可单独查词</span>${members.map((member, i) => `<button type="button" data-member="${i}">${e(member[0])}</button>`).join("")}`;
    section.append(actions);
    scope.on(actions, "click", (event) => {
      const button = event.target.closest("[data-member]");
      if (!button) return;
      const member = members[+button.dataset.member],
        start = anchor.start + member.index;
      const part = reader.anchorFor(
        anchor.block_id,
        start,
        start + member[0].length,
      );
      const source = [
        ...document.querySelectorAll("#article .source-unit"),
      ].find(
        (node) =>
          node.dataset.sourceBlock === anchor.block_id &&
          +node.dataset.sourceStart <= start &&
          +node.dataset.sourceEnd > start,
      );
      if (source && part) void reader.lookup(member[0], source, part);
      else toast("这个词目前不在可见原文中，请先回到该处。");
    });
  }
  const render = () => {
    if (scope.signal.aborted) return;
    renderDictionary();
    saved = controller.state.items.find(
      (value) => value.kind === "word" && sameSelection(value.anchor, anchor),
    );
    feedback = controller.state.feedback.find((value) =>
      sameSelection(value.anchor, anchor),
    );
    candidate = [
      pop.contextRecord,
      ...[...(reader.assists || [])].reverse(),
    ].find(
      (value) =>
        value?.kind === "context" &&
        !value.historical &&
        sameSelection(value.anchor, anchor),
    );
    for (const [selector, active, label] of [
      [
        "[data-collection-word]",
        Boolean(saved),
        saved ? "已收藏词语 ✓" : "收藏词语",
      ],
      [
        "[data-understood]",
        feedback?.understood === true,
        feedback?.understood === true ? "已懂这里 ✓" : "已懂这里",
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
    $("[data-word-adopt]", section).hidden =
      !saved ||
      !candidate ||
      Number(saved.explanation?.assist_id) === Number(candidate.id);
    $("[data-state-retry]", section).hidden = !controller.error;
    if (!busy)
      status.textContent = controller.error
        ? `记录未能加载：${controller.error.message}`
        : "";
  };
  scope.on(section, "click", async (event) => {
    const button = event.target.closest(
      "[data-collection-word],[data-understood],[data-retained],[data-word-edit],[data-word-adopt],[data-state-retry]",
    );
    if (!button || button.disabled || busy) return;
    if (
      button.hasAttribute("data-word-edit") ||
      button.hasAttribute("data-word-adopt")
    ) {
      if (saved)
        editCollection(
          ctx,
          store,
          saved,
          reader.scope,
          button.hasAttribute("data-word-adopt") ? candidate : null,
        );
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
          message = understood ? "已记录：懂得这里的用法" : "已回到未反馈状态";
        } else {
          const retained = !feedback?.retained;
          const note =
            item.note ||
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
                  detail: item.detail || "",
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
  scope.on(controller.events, "state", render);
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
    if (managedDictionary && meaning) meaning.hidden = originalMeaningHidden;
    if (managedDictionary && detail) detail.hidden = originalDetailHidden;
    section.remove();
    dictionary.remove();
  });
  render();
  return scope;
}
