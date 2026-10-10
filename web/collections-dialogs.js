import { $, e, api, local, toast } from "./core.js";
import {
  anchorSegments,
  sameSelection,
  sourceExcerpt,
} from "./source-selection.js";
import {
  childScope,
  collectionSource,
  contextText,
  explanationText,
} from "./collections-store.js";

export function collectionDialog(store, owner, title, html) {
  const scope = childScope(store.scope, owner),
    dialog = document.createElement("dialog");
  const returnFocus = document.activeElement;
  dialog.className = "collections-dialog";
  dialog.setAttribute("aria-label", title);
  dialog.innerHTML = `<header><h2>${e(title)}</h2><button type="button" data-close aria-label="关闭">×</button></header>${html}`;
  // A nested preview, close button or backdrop can dispose this scope while
  // its input event is still dispatching. Keep the propagation boundary on
  // the dialog node (not its abort signal), including on the old event path
  // after removal. Detached nodes/listeners are then garbage-collectable.
  // Bubble only: child controls and delegated dialog actions still run, and
  // native focus, text editing, selection and scrolling keep their defaults.
  // The reader's document-capture handlers must separately ignore dialogs.
  for (const type of [
    "pointerdown",
    "pointermove",
    "pointerup",
    "pointercancel",
    "mousedown",
    "mousemove",
    "mouseup",
    "click",
    "dblclick",
    "auxclick",
    "contextmenu",
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
    "wheel",
    "keydown",
    "keyup",
  ]) {
    dialog.addEventListener(type, (event) => event.stopPropagation(), {
      passive: true,
    });
  }
  document.body.append(dialog);
  let beforeClose = async () => {},
    closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await beforeClose();
      if (!scope.signal.aborted) scope.dispose();
    } catch (error) {
      toast(error.message);
    } finally {
      closing = false;
    }
  };
  scope.on($("[data-close]", dialog), "click", (event) => {
    event.stopPropagation();
    void close();
  });
  scope.on(dialog, "cancel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void close();
  });
  scope.on(dialog, "click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      void close();
  });
  scope.cleanup(() => {
    dialog.close();
    dialog.remove();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
  if (!scope.signal.aborted) dialog.showModal();
  else scope.dispose();
  return {
    dialog,
    scope,
    close,
    beforeClose(fn) {
      beforeClose = fn;
    },
  };
}

export function previewCollection(ctx, store, item, owner) {
  const modal = collectionDialog(
    store,
    owner,
    "原文预览",
    `<p class="collections-source">${e(collectionSource(item))}</p><p class="collections-help">收藏时的原文片段${item.context_truncated ? " · 较长上下文已截取" : ""}</p><blockquote class="collections-quote">${e(sourceExcerpt(item.quote))}</blockquote><p class="collections-context">${e(contextText(item.context))}</p><details data-current-context hidden><summary>当前可核对的上下文</summary><p class="collections-context"></p></details><p class="collections-status" role="status">正在核对原文来源…</p><button type="button" class="button primary" data-continue disabled>从这里继续读</button><p class="collections-help">关闭预览后回到当前入口。</p>`,
  );
  const { dialog, scope } = modal;
  let source,
    navigating = false;
  const button = $("[data-continue]", dialog),
    status = $("[role=status]", dialog);
  const load = async () => {
    source = await store.read(`/${encodeURIComponent(item.id)}/source`, scope);
    if (scope.signal.aborted) return;
    $(".collections-source", dialog).textContent = collectionSource(source);
    $(".collections-context", dialog).textContent =
      contextText(source.context) || contextText(item.context);
    const current = $("[data-current-context]", dialog);
    current.hidden =
      !source.available || !source.historical || !source.current_context;
    $("p", current).textContent = contextText(source.current_context);
    button.disabled = !source.available || !source.doc_id || !source.anchor;
    status.textContent = source.available
      ? source.historical
        ? "这是保存时的引用；已找到可核对的原文位置。"
        : "已核对来源。继续阅读才会更新阅读位置。"
      : `目前无法回到原文：${source.reason || "原件不可用或位置无法可靠核对"}。收藏快照仍保留。`;
  };
  void load().catch((error) => {
    if (!scope.signal.aborted)
      status.textContent = `来源核对失败：${error.message}。保存的引用仍可阅读。`;
  });
  scope.on(button, "click", async () => {
    if (navigating || !source?.available) return;
    navigating = true;
    button.disabled = true;
    try {
      // The source may have been recycled/revised while the preview was open.
      await load();
      if (scope.signal.aborted || !source.available) return;
      const destination = source;
      await modal.close();
      if (
        dialog.isConnected ||
        owner?.signal?.aborted ||
        store.scope.signal.aborted
      )
        return;
      ctx.jump(destination.doc_id, destination.anchor);
    } catch (error) {
      if (!scope.signal.aborted)
        status.textContent = `暂时无法继续：${error.message}`;
    } finally {
      navigating = false;
      if (!scope.signal.aborted) button.disabled = !source?.available;
    }
  });
  return modal;
}

function renderExplanation(value) {
  return value
    ? `<p class="collections-text">${e(explanationText(value))}</p><p class="collections-source">${e(value.source || value.kind || "保存的解释")}</p>`
    : '<p class="collections-help">还没有保存解释。</p>';
}

// Capture semantic source/range identity before any revision is replaced.
// Sort object keys, but preserve segment order and raw UTF-16 source quotes.
function meaningRangeIdentity(item) {
  if (
    !item.source_identity ||
    !item.anchor?.version ||
    typeof item.quote !== "string"
  )
    return null;
  const part = (value) => [
    value.version || item.anchor.version,
    value.block_id,
    value.start,
    value.end,
    value.quote,
  ];
  return JSON.stringify(
    [
      item.uid,
      item.kind,
      item.source_identity,
      part(item.anchor),
      anchorSegments(item.anchor).map(part),
      item.quote,
    ],
    (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
  );
}

function meaningDrafts(prefix) {
  const drafts = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (!storageKey?.startsWith("wr2:")) continue;
      const key = storageKey.slice(4);
      if (key !== prefix && !key?.startsWith(`${prefix}:`)) continue;
      const value = local.get(key);
      if (value?.identity && typeof value.text === "string")
        drafts.push({ key, ...value });
    }
  } catch {
    // Storage can be disabled. Saving will report failure and leave the input.
  }
  return drafts.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

function draftQuote(draft) {
  try {
    return JSON.parse(draft.identity)[2] || "（此前的引用不可用）";
  } catch {
    return "（此前的引用不可用）";
  }
}

function clearScopedDrafts(selection) {
  if (!selection.collections) return;
  const ids = new Set((selection.ids || []).map(String));
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith("wr2:collection-meaning:")) keys.push(key.slice(4));
  }
  for (const key of keys) {
    const draft = local.get(key);
    if (
      (selection.book_id &&
        String(draft?.book_id) === String(selection.book_id)) ||
      ids.has(String(draft?.collection_id))
    )
      local.remove(key);
  }
}

export function editCollection(
  ctx,
  store,
  original,
  owner,
  initialCandidate = null,
) {
  let item = original;
  const rangeIdentity = meaningRangeIdentity(original);
  const isOriginalRange = (value) =>
    rangeIdentity !== null && meaningRangeIdentity(value) === rangeIdentity;
  const draftPrefix = `collection-meaning:${item.uid || item.id}`;
  const identity = JSON.stringify([
    item.source_identity,
    item.anchor,
    item.quote,
  ]);
  const drafts = meaningDrafts(draftPrefix);
  const draft = drafts.find((value) =>
    value.range_identity
      ? value.range_identity === rangeIdentity
      : value.identity === identity,
  );
  // Separate keys keep an old range's draft recoverable after a union is
  // reopened and edited. The unsuffixed pre-R4 draft key is still readable.
  const draftKey = draft?.key || `${draftPrefix}:${crypto.randomUUID()}`;
  const otherDrafts = drafts.filter((value) => value !== draft);
  const modal = collectionDialog(
    store,
    owner,
    "收藏详情",
    `<p class="collections-source">${e(collectionSource(item))}</p><blockquote class="collections-quote">${e(sourceExcerpt(item.quote))}</blockquote><div data-explanation></div><label class="collections-label">我的释义<textarea data-meaning rows="4" maxlength="20000" placeholder="只记录你对这一次用法的理解">${e(item.my_meaning)}</textarea></label><p data-save-status class="collections-status" role="status">输入即自动保存</p><section data-range-change hidden></section><div class="collections-actions"><button type="button" data-retry hidden>重新核对版本</button><button type="button" data-existing>查看已有语境解释</button><button type="button" data-preview>回原文</button></div>${otherDrafts.length ? `<details open><summary>此前未保存的草稿 · ${otherDrafts.length}</summary><p class="collections-help">这些输入仍对应各自的原引用，仅供查看和复制，不会自动填入或保存到当前收藏。</p>${otherDrafts.map((value) => `<section class="collections-history-entry"><blockquote class="collections-context">${e(sourceExcerpt(draftQuote(value)))}</blockquote><label class="collections-label">原引用的草稿<textarea rows="3" readonly>${e(value.text)}</textarea></label></section>`).join("")}</details>` : ""}<div data-candidates></div><div data-history></div><div data-references></div>`,
  );
  const { dialog, scope } = modal,
    input = $("[data-meaning]", dialog),
    status = $("[data-save-status]", dialog);
  let saved = item.my_meaning || "",
    timer,
    inflight,
    failed = false,
    rangeChanged = false,
    draftKept = false;
  const rangeChangedMessage =
    "收藏的来源、版本或范围已变化；这份输入只对应上方原引用，不能保存到当前整条收藏。";
  if (draft && draft.text !== saved) {
    input.value = draft.text;
    failed = true;
    status.textContent = "有上次尚未保存的输入。请先核对当前版本再保存。";
    $("[data-retry]", dialog).hidden = false;
  }
  const persistDraft = () => {
    if (input.value === saved) {
      try {
        local.remove(draftKey);
      } catch {
        /* A stale equal draft is harmless. */
      }
      return true;
    }
    return local.set(draftKey, {
      identity,
      range_identity: rangeIdentity,
      text: input.value,
      revision: item.revision,
      collection_id: item.id,
      book_id: item.book_id,
      updated_at: Date.now(),
    });
  };
  const keepDraft = document.createElement("button");
  keepDraft.type = "button";
  keepDraft.textContent = "保留未保存输入，稍后继续";
  keepDraft.hidden = !failed;
  $("[data-retry]", dialog).after(keepDraft);
  scope.on(keepDraft, "click", () => {
    if (!persistDraft()) {
      status.textContent = "本机草稿保存失败，请复制输入后再关闭。";
      return;
    }
    draftKept = true;
    modal.beforeClose(async () => {});
    void modal.close();
  });
  const showRangeChange = (latest) => {
    clearTimeout(timer);
    failed = true;
    rangeChanged = true;
    keepDraft.hidden = false;
    status.textContent = `${rangeChangedMessage}${persistDraft() ? "草稿已保留；重新打开收藏后可查看和复制原引用的输入。" : "本机草稿保存失败，请复制输入后再关闭。"}`;
    const change = $("[data-range-change]", dialog);
    change.hidden = false;
    change.innerHTML = `<h3>当前收藏的引用</h3><p class="collections-source">${e(collectionSource(latest))}</p><blockquote class="collections-quote">${e(sourceExcerpt(latest.quote))}</blockquote><p class="collections-help">上方编辑框仍保留原引用的输入；不会将它套用到这条变化后的引用。</p>`;
  };
  const render = () => {
    $("[data-explanation]", dialog).innerHTML =
      `<h3>已保存的解释</h3>${renderExplanation(item.explanation)}`;
    $("[data-history]", dialog).innerHTML = item.explanation_history?.length
      ? `<details><summary>此前的解释 · ${item.explanation_history.length}</summary>${item.explanation_history.map((value) => `<section class="collections-history-entry">${renderExplanation(value.explanation || value)}</section>`).join("")}</details>`
      : "";
    const references = item.references || item.subranges || [];
    $("[data-references]", dialog).innerHTML = references.length
      ? `<details><summary>合并前的片段与个人内容 · ${references.length}</summary>${references.map((value) => `<section class="collections-history-entry"><blockquote class="collections-context">${e(sourceExcerpt(value.quote || value.anchor?.quote))}</blockquote>${renderExplanation(value.explanation)}${value.my_meaning ? `<p>我的释义：${e(value.my_meaning)}</p>` : ""}${value.explanation_history?.length ? `<details><summary>这个片段的解释历史</summary>${value.explanation_history.map(renderExplanation).join("")}</details>` : ""}</section>`).join("")}</details>`
      : "";
  };
  const flush = () => {
    clearTimeout(timer);
    if (inflight) return inflight;
    if (input.value === saved) return Promise.resolve();
    if (failed)
      return Promise.reject(
        new Error(
          rangeChanged
            ? rangeChangedMessage
            : "释义尚未保存，请先重新核对版本；输入内容仍保留。",
        ),
      );
    inflight = (async () => {
      while (input.value !== saved) {
        const text = input.value;
        status.textContent = "正在保存…";
        try {
          if (!isOriginalRange(item)) throw new Error(rangeChangedMessage);
          const result = await store.write(
            `/${encodeURIComponent(item.id)}`,
            { my_meaning: text, expected_revision: item.revision },
            "PATCH",
          );
          item = result.item;
          saved = text;
          persistDraft();
          status.textContent = "已保存";
        } catch (error) {
          failed = true;
          status.textContent = `尚未保存：${error.message}。请保留或复制输入内容。`;
          $("[data-retry]", dialog).hidden = false;
          keepDraft.hidden = false;
          throw error;
        }
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
  const editor = { flush, dirty: () => input.value !== saved };
  store.editors.add(editor);
  modal.beforeClose(flush);
  scope.on(input, "input", () => {
    const retained = persistDraft();
    status.textContent = !retained
      ? "本机草稿保存失败，请复制输入。"
      : rangeChanged
        ? `${rangeChangedMessage}草稿已保留。`
        : failed
          ? "输入已保留，请先重新核对版本"
          : "等待保存…";
    clearTimeout(timer);
    if (!failed) timer = setTimeout(() => void flush().catch(() => {}), 550);
  });
  scope.on(input, "blur", () => {
    if (!failed) void flush().catch(() => {});
  });
  scope.cleanup(() => {
    clearTimeout(timer);
    void (draftKept ? Promise.resolve() : flush())
      .catch((error) => toast(`我的释义尚未保存：${error.message}`))
      .finally(() => store.editors.delete(editor));
  });
  scope.on($("[data-retry]", dialog), "click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      let latest,
        offset = 0;
      do {
        const data = await store.read(
          `?${new URLSearchParams({ ...(original.doc_id ? { doc_id: original.doc_id } : {}), limit: 200, offset })}`,
          scope,
        );
        if (scope.signal.aborted) return;
        latest = data.items.find(
          (value) => String(value.id) === String(original.id),
        );
        offset += data.items.length;
        if (latest || !data.items.length || offset >= data.total) break;
      } while (!scope.signal.aborted);
      if (!latest)
        throw new Error(
          "这条收藏已变化或不在返回结果内；请关闭前复制输入内容，并从列表重新打开。",
        );
      if (!isOriginalRange(latest)) {
        showRangeChange(latest);
        return;
      }
      const review = collectionDialog(
        store,
        scope,
        "核对我的释义",
        `<p class="collections-help">已核对来源、原文版本和完整范围一致。</p><blockquote class="collections-quote">${e(sourceExcerpt(latest.quote))}</blockquote><h3>当前保存</h3><p class="collections-text">${e(latest.my_meaning || "（空）")}</p><h3>你的输入</h3><p class="collections-text">${e(input.value)}</p><button type="button" data-save-current>用我的输入保存</button><button type="button" data-use-current>使用当前保存</button>`,
      );
      review.scope.on(
        $("[data-save-current]", review.dialog),
        "click",
        async () => {
          item = latest;
          saved = latest.my_meaning || "";
          failed = false;
          rangeChanged = false;
          $("[data-range-change]", dialog).hidden = true;
          keepDraft.hidden = true;
          $("[data-retry]", dialog).hidden = true;
          persistDraft();
          status.textContent =
            input.value === saved ? "已与当前保存内容一致" : "等待保存…";
          render();
          await review.close();
          void flush().catch(() => {});
        },
      );
      review.scope.on($("[data-use-current]", review.dialog), "click", () => {
        item = latest;
        input.value = saved = latest.my_meaning || "";
        failed = false;
        rangeChanged = false;
        $("[data-range-change]", dialog).hidden = true;
        keepDraft.hidden = true;
        persistDraft();
        status.textContent = "已使用当前保存内容";
        $("[data-retry]", dialog).hidden = true;
        render();
        void review.close();
      });
    } catch (error) {
      if (!scope.signal.aborted) status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  scope.on($("[data-preview]", dialog), "click", () =>
    previewCollection(ctx, store, item, scope),
  );
  const candidates = $("[data-candidates]", dialog);
  let values = [];
  const showCandidates = (list) => {
    values = list.filter(
      (value) =>
        value.kind === "context" &&
        !value.historical &&
        sameSelection(value.anchor, item.anchor),
    );
    candidates.innerHTML = values.length
      ? `<h3>先查看，再采用</h3>${values.map((value, i) => `<section class="collections-history-entry">${renderExplanation(value)}${Number(item.explanation?.assist_id) === Number(value.id) ? '<span class="collections-help">当前已采用</span>' : `<button type="button" data-adopt="${i}">采用这条解释</button>`}</section>`).join("")}`
      : '<p class="collections-help">这处原文还没有可采用的解释。可回到原文主动解释后再查看。</p>';
  };
  scope.on($("[data-existing]", dialog), "click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const source = await store.read(
        `/${encodeURIComponent(item.id)}/source`,
        scope,
      );
      if (!source.available || source.historical)
        throw new Error(
          source.reason ||
            "当前原文与保存时的内容无法确认一致，仅保留已有解释。",
        );
      const list = await api(`/documents/${source.doc_id}/assists`, {
        signal: scope.signal,
      });
      if (!scope.signal.aborted) showCandidates(list);
    } catch (error) {
      if (!scope.signal.aborted) candidates.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  scope.on(candidates, "click", async (event) => {
    const button = event.target.closest("[data-adopt]");
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      await flush();
      const candidate = values[+button.dataset.adopt];
      const result = await store.write(
        `/${encodeURIComponent(item.id)}`,
        { adopt_assist_id: candidate.id, expected_revision: item.revision },
        "PATCH",
      );
      item = result.item;
      if (!scope.signal.aborted) {
        render();
        showCandidates(values);
      }
      store.undo(result, "已采用解释；此前解释仍可回看");
    } catch (error) {
      if (!scope.signal.aborted) toast(error.message);
    } finally {
      button.disabled = false;
    }
  });
  render();
  if (initialCandidate) showCandidates([initialCandidate]);
  return modal;
}

export function manageCollections(
  store,
  owner,
  { bookId, bookTitle, selected, selectedQuotes = [] },
) {
  const ids = [...selected];
  const modal = collectionDialog(
    store,
    owner,
    "收藏资料",
    `<fieldset><legend>操作范围</legend><label><input type="radio" name="collections-scope" value="selected" ${ids.length ? "checked" : "disabled"}>已选 ${ids.length} 条收藏及其关联记录</label>${bookId ? `<label><input type="radio" name="collections-scope" value="book" ${!ids.length ? "checked" : ""}>整本书：${e(bookTitle || "当前书籍")}</label>` : ""}<label><input type="radio" name="collections-scope" value="all" ${!ids.length && !bookId ? "checked" : ""}>全部收藏（仅导出）</label>${ids.length ? `<details><summary>查看选中的引用</summary>${selectedQuotes.map((quote) => `<p class="collections-context">${e(sourceExcerpt(quote))}</p>`).join("")}</details>` : ""}</fieldset><fieldset><legend>包含哪些资料</legend><label><input type="checkbox" data-type="collections" checked>词句收藏、我的释义与解释历史</label><label><input type="checkbox" data-type="notes">独立笔记</label><label><input type="checkbox" data-type="feedback">已懂这里与保留注释</label></fieldset><div class="collections-actions"><button type="button" data-export="json">导出恢复资料 JSON</button><button type="button" data-export="markdown">导出可读 Markdown</button></div><hr><h3>恢复收藏资料</h3><input type="file" data-import-file accept=".json,application/json" aria-label="选择恢复资料 JSON"><button type="button" data-import disabled>恢复所选文件</button><p class="collections-help">恢复引用、解释和所选个人内容；原书需另行导入。</p><hr><h3>永久清理所选资料</h3><p class="collections-help">按上方范围和勾选类型清理；原书保留。此操作不能撤销。</p><label><input type="checkbox" data-confirm>我确认永久清理上述范围内勾选的资料</label><button type="button" class="collections-danger" data-cleanup disabled>永久清理</button><p class="collections-status" role="status"></p>`,
  );
  const { dialog, scope } = modal,
    status = $("[role=status]", dialog);
  let pending = false;
  const payload = () => {
    const value = $("input[name=collections-scope]:checked", dialog).value;
    return {
      ...(value === "selected"
        ? { ids }
        : value === "book"
          ? { book_id: bookId }
          : {}),
      ...Object.fromEntries(
        [...dialog.querySelectorAll("[data-type]")].map((input) => [
          input.dataset.type,
          input.checked,
        ]),
      ),
    };
  };
  const run = async (button, fn) => {
    if (pending) return;
    pending = true;
    button.disabled = true;
    status.textContent = "正在处理…";
    try {
      if (!button.hasAttribute("data-import") && payload().ids?.length > 500)
        throw new Error(
          "一次最多操作 500 条选中记录，请减少选择或按整本书操作。",
        );
      await fn();
    } catch (error) {
      if (!scope.signal.aborted)
        status.textContent = `未完成：${error.message}`;
    } finally {
      pending = false;
      if (!scope.signal.aborted) update();
    }
  };
  const update = () => {
    const chosen = payload(),
      some = chosen.collections || chosen.notes || chosen.feedback;
    for (const button of dialog.querySelectorAll("[data-export]"))
      button.disabled = pending || !some;
    $("[data-cleanup]", dialog).disabled =
      pending ||
      !some ||
      (!chosen.book_id && !chosen.ids?.length) ||
      !$("[data-confirm]", dialog).checked;
    $("[data-import]", dialog).disabled =
      pending || !$("[data-import-file]", dialog).files.length;
  };
  scope.on(dialog, "change", (event) => {
    if (event.target.matches("[data-type],[name=collections-scope]"))
      $("[data-confirm]", dialog).checked = false;
    update();
  });
  scope.on(dialog, "click", (event) => {
    const button = event.target.closest(
      "[data-export],[data-import],[data-cleanup]",
    );
    if (!button || button.disabled) return;
    void run(button, async () => {
      if (button.hasAttribute("data-export")) {
        const response = await fetch("/api/collections/export", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          signal: scope.signal,
          body: JSON.stringify({ ...payload(), format: button.dataset.export }),
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(
            typeof error.detail === "string" ? error.detail : "导出失败",
          );
        }
        const blob = await response.blob(),
          url = URL.createObjectURL(blob),
          link = document.createElement("a");
        link.href = url;
        link.download = `wise-reader-collections-${new Date().toISOString().slice(0, 10)}.${button.dataset.export === "json" ? "json" : "md"}`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        status.textContent = "已生成下载文件";
      } else if (button.hasAttribute("data-import")) {
        const file = $("[data-import-file]", dialog).files[0];
        if (file.size > 8 * 1024 * 1024)
          throw new Error("文件超过 8 MB，请拆分后恢复。");
        let data;
        try {
          data = JSON.parse(await file.text());
        } catch {
          throw new Error("文件不是有效的 JSON 恢复资料。");
        }
        const result = await store.write("/import", { data });
        status.textContent = `已恢复 ${result.imported} 条；重复 ${result.duplicates} 条；${result.unresolved} 条暂不能定位原文。`;
      } else {
        const selection = payload();
        const result = await store.write("/cleanup", {
          ...selection,
          confirm: true,
        });
        status.textContent = `已清理：收藏 ${result.removed.collections}、笔记 ${result.removed.notes}、反馈 ${result.removed.feedback}。原书保留。`;
        try {
          clearScopedDrafts(selection);
        } catch {
          status.textContent +=
            " 本机未保存输入暂未能清理，请恢复浏览器存储访问后重试。";
        }
        $("[data-confirm]", dialog).checked = false;
      }
    });
  });
  modal.beforeClose(async () => {
    if (pending) throw new Error("资料操作正在进行，请等待结果后关闭。");
  });
  update();
  return modal;
}
