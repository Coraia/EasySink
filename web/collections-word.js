import { setReadingAction, actionIcon } from "./reading-action-icons.js";
import { $, e, api, toast } from "./core.js";
import { sameSelection } from "./source-selection.js";
import { childScope } from "./collections-store.js";
import { editCollection } from "./collections-dialogs.js";
import { adoptedAt } from "./collections-context.js";
import { dictionaryAnnotationNote } from "./dictionary-card.js";

export function mountCollectionWord(
  ctx,
  store,
  { reader, pop, item, anchor, scope: parentScope },
) {
  const controller = reader.collectionsController;
  reader.pages?.wordReflow?.focus(anchor);
  const preparedNote = dictionaryAnnotationNote(item);
  if(reader.pages?.wordReflow?.initialHasNote) reader.pages.wordReflow.prepareNote(null);
  else if(preparedNote) reader.pages?.wordReflow?.prepareNote(preparedNote);
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
  ($(".word-card-title", pop) || $("h3", pop)).after(currentMeaning);
  const section = document.createElement("section");
  section.className = "collections-word";
  section.innerHTML = `<div class="collections-scope-line"><span data-usage-label>正在读取适用表达…</span><button type="button" data-usage-edit aria-label="更正适用表达" title="更正适用表达">${actionIcon("edit")}</button><button type="button" data-learning-open aria-label="查看标注反馈趋势" title="查看标注反馈趋势">${actionIcon("grammar")}<span>趋势</span></button></div>
    <div class="collections-independent" role="group" aria-label="注释反馈"><button type="button" data-usage-action="need"></button><button type="button" data-usage-action="known"></button><button type="button" data-retained></button></div>
    <p class="collections-help">加减按适用表达跨书复用 · 保留仅此处</p><p class="collections-help" id="word-annotation-availability" data-annotation-availability hidden></p><div class="collections-usage-status"><span data-usage-status></span><button type="button" data-usage-action="auto" hidden></button></div>
    <div data-usage-editor hidden><label>适用表达<select data-usage-scope aria-label="适用表达"></select></label><p class="collections-help">仅复用原文中的相同表达；不同搭配独立。无法确定时保留为待确认，不按拼写合并词义。</p><button type="button" data-usage-confirm>确认范围</button></div>
    <p class="collections-status" role="status"></p><div class="collections-actions"><button type="button" data-word-edit hidden>我的释义 / 已存解释</button><button type="button" data-state-retry hidden>重新加载记录</button></div>`;
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.dataset.collectionWord = "";
  saveButton.className = "word-save-action";
  ($( ".word-card-title .close", pop) || $(".close", pop)).before(saveButton);
  const meaning = $(".meaning", pop),
    detail = $(".word-gloss-detail", pop) || $(":scope > p.muted", pop);
  ($(".dictionary-candidates", pop) || meaning || $("h3", pop)).after(
    section,
  );
  let busy = false,
    saved = null,
    feedback = null,
    suppressedMeaning = null;
  let usageChoices = null, chosenScope = null, editorOpen = false, usageError = null;
  const status = $("[role=status]", section);
  const annotationNotes = () => {
    const dictionary = dictionaryAnnotationNote(item);
    const adopted = adoptedAt(controller.state, anchor)?.payload.meaning?.trim() || "";
    const local = item.source !== "dictionary" && typeof item.note === "string" ? item.note.trim() : "";
    return { dictionary, local: adopted || local || dictionary };
  };
  const emptyScopedNeed = () => feedback?.annotation_preference === "need" &&
    !(typeof feedback.preference_note === "string" && feedback.preference_note.trim());
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
    const matched = controller.state.usage_matches?.find(value => sameSelection(value.anchor, anchor));
    const action = matched?.annotation_preference;
    const localScope = feedback?.usage;
    if (chosenScope === null && usageChoices) {
      chosenScope = usageChoices.find(choice => localScope && ["pattern", "target_start", "target_end"].every(key => choice.usage[key] === localScope[key]))?.id ||
        (feedback && Object.hasOwn(feedback, "usage") ? "pending" : matched?.scope_id) || usageChoices.find(choice => !choice.requires_confirmation)?.id || "pending";
    }
    const selectScope = $("[data-usage-scope]", section);
    if (selectScope.options.length) selectScope.value = chosenScope;
    const chosen = usageChoices?.find(value => value.id === chosenScope);
    $("[data-usage-label]", section).textContent = usageChoices ? chosen ? `适用表达：${chosen.usage.pattern}` : "用法待确认" : "正在读取适用表达…";
    $("[data-usage-status]", section).textContent = action === "known" ? "此用法已认识" : action === "need" ? "此用法需要注释" : feedback?.understood === true ? "此前记录：已掌握本处" : "未反馈";
    if (action && action !== "auto" && !matched.usage) $("[data-usage-status]", section).textContent += " · 等待确认范围";
    setReadingAction(saveButton, "star", saved ? "已收藏" : "收藏", saved ? "取消收藏词语" : "收藏词语");
    saveButton.setAttribute("aria-pressed", String(Boolean(saved)));
    saveButton.disabled = busy || !controller.loaded;
    const notes = annotationNotes();
    const availability = $("[data-annotation-availability]", section);
    availability.hidden = Boolean(notes.dictionary) && !emptyScopedNeed();
    availability.textContent = emptyScopedNeed()
      ? "此前的需注释记录没有可用释义；请重新选择有效的“需注释”或“恢复自动”，再更正范围。"
      : notes.dictionary ? "" : notes.local
      ? "当前暂无可复用的词典释义；本处已有解释，可用“仅此处”保留。"
      : "当前暂无可复用的词典释义；可点“解释”，采用后用“仅此处”保留。";
    for (const [selector, glyph, label, name, active] of [
      ['[data-usage-action="need"]', 'plus', '需注释', '需注释：后续相同适用表达继续显示', action === 'need'],
      ['[data-usage-action="known"]', 'minus', '认识', '认识：后续相同适用表达不再自动标注', action === 'known' || feedback?.understood === true],
      ['[data-retained]', 'pin', '仅此处', '仅此处保留注释', Boolean(feedback?.retained)],
      ['[data-usage-action="auto"]', 'reset', '恢复自动', '恢复自动判断', false],
    ]) {
      const button = $(selector, section);
      setReadingAction(button, glyph, label, name);
      button.setAttribute('aria-pressed', String(active));
      const unavailable = button.dataset.usageAction === "need" ? !notes.dictionary
        : button.hasAttribute("data-retained") ? !feedback?.retained && !notes.local : false;
      button.disabled = busy || !controller.loaded || (button.dataset.usageAction && !usageChoices) || unavailable;
      if (unavailable) button.setAttribute("aria-describedby", availability.id);
      else button.removeAttribute("aria-describedby");
    }
    $('[data-usage-action="auto"]', section).hidden = !((action && action !== 'auto') || feedback?.understood === true);
    $('[data-usage-editor]', section).hidden = !editorOpen;
    $('[data-usage-edit]', section).disabled = !usageChoices || busy;
    const confirmScope = $('[data-usage-confirm]', section);
    confirmScope.disabled = !usageChoices || busy || emptyScopedNeed();
    if (emptyScopedNeed()) confirmScope.setAttribute("aria-describedby", availability.id);
    else confirmScope.removeAttribute("aria-describedby");
    $("[data-word-edit]", section).hidden = !saved;
    $("[data-state-retry]", section).hidden = !controller.error && !usageError;
    $(".collections-actions", section).hidden = !saved && !controller.error && !usageError;
    if (!busy)
      status.textContent = controller.error
        ? `记录未能加载：${controller.error.message}`
        : usageError ? `适用表达暂不可用：${usageError.message}` : "";
  };
  const onAction = async (event) => {
    const button = event.target.closest(
      "[data-collection-word],[data-usage-action],[data-usage-edit],[data-usage-confirm],[data-learning-open],[data-retained],[data-word-edit],[data-state-retry]",
    );
    if (!button || button.disabled || busy) return;
    // Recheck at the write boundary, before exposure capture or an async write.
    const notes = annotationNotes();
    if ((button.dataset.usageAction === "need" && !notes.dictionary) ||
        (button.hasAttribute("data-retained") && !feedback?.retained && !notes.local) ||
        (button.hasAttribute("data-usage-confirm") && emptyScopedNeed())) {
      render();
      return;
    }
    if (button.hasAttribute("data-learning-open")) { await reader.learning?.openStats(); return; }
    if (button.hasAttribute("data-usage-edit")) { editorOpen = !editorOpen; render(); return; }
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
      if (button.hasAttribute("data-state-retry")) { await controller.reload(); if (usageError) await loadUsage(); }
      else if (button.dataset.usageAction || button.hasAttribute("data-usage-confirm")) {
        const action = button.dataset.usageAction || 'scope';
        await reader.learning?.captureFocused(anchor);
        // The structured lookup may have arrived while exposure capture waited.
        const note = annotationNotes().dictionary;
        if (scope.signal.aborted || (action === 'need' && !note) ||
            (action === 'scope' && emptyScopedNeed())) return;
        if (action === 'known' || action === 'need') reader.pages?.wordReflow?.prepareNote(action === 'known' ? null : note);
        const result = await store.write('/usage-feedback', { doc_id: reader.doc.id, anchor, action,
          scope_id: chosenScope || 'pending', note: note || '', detail: '', target: item.target || anchor.quote });
        editorOpen = false;
        store.undo(result, action === 'scope' ? '已更正适用表达；反馈随范围复用' : action === 'auto' ? '已恢复自动判断' : chosenScope === 'pending' ? '反馈已保存，确认用法范围后复用' : action === 'known' ? '已认识此用法；其他位置明确保留的注释仍显示' : '相同适用表达将继续显示词注');
        await controller.reload();
      }
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
        {
          const retained = !feedback?.retained;
          const adopted = adoptedAt(controller.state, anchor);
          const note = notes.local;
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
      if (reader.annotationDrawPromise) await reader.annotationDrawPromise;
    } catch (error) {
      if (!scope.signal.aborted) toast(error.message);
    } finally {
      busy = false;
      render();
    }
  };
  scope.on(section, "click", onAction);
  scope.on(saveButton, "click", onAction);
  scope.on(section, "change", event => { if (event.target.matches("[data-usage-scope]")) chosenScope = event.target.value; });
  async function loadUsage() {
    usageError = null;
    try {
      const value = await api("/collections/usage-preview", {method: "POST", body: {doc_id: reader.doc.id, anchor}, signal: scope.signal});
      if (scope.signal.aborted) return;
      if (!Array.isArray(value.choices)) throw new Error("适用表达返回格式不完整");
      usageChoices = value.choices;
      render();
      const select = $("[data-usage-scope]", section);
      select.innerHTML = usageChoices.map(choice => `<option value="${e(choice.id)}">${e(choice.usage.pattern)}</option>`).join("") + '<option value="pending">暂时无法确定</option>';
      select.value = chosenScope;
    } catch (error) {
      if (!scope.signal.aborted) { usageError = error; render(); }
    }
  }
  loadUsage();
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
    if (!editorOpen) chosenScope = null;
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
    saveButton.remove();
    section.remove();
    currentMeaning.remove();
    delete pop.adoptContext;
  });
  render();
  return scope;
}
