import { $, e, api, date, toast } from "./core.js";
import {
  childScope,
  collectionSource,
  contextText,
  explanationText,
} from "./collections-store.js";
import {
  previewCollection,
  editCollection,
  manageCollections,
} from "./collections-dialogs.js";

export function mountCollectionsList(
  ctx,
  store,
  root,
  owner,
  { bookId = null, docId = null, title = "词句收藏" } = {},
) {
  const scope = childScope(store.scope, owner);
  root.classList.add("collections-view");
  root.innerHTML = `<header class="collections-heading"><div>${!bookId && !docId ? `<p class="collections-eyebrow">SAVED IN CONTEXT</p><h2>${e(title)}</h2>` : ""}</div><button type="button" data-manage>资料管理</button></header><div class="collections-filters"><label>查找<input type="search" data-query placeholder="查找词句或我的释义" maxlength="200"></label><label>类型<select data-kind><option value="">全部词句</option><option value="word">词语</option><option value="excerpt">摘录划线</option></select></label>${!bookId && !docId ? '<label>来源<select data-book><option value="">所有书籍与文章</option></select></label>' : ""}<label class="collections-inline"><input type="checkbox" data-group>同词归组</label></div><p class="collections-help" data-group-note hidden>按已加载词形归组；每次原句与来源分别保留，不推定为同一词义。</p><div class="collections-actions"><label class="collections-inline"><input type="checkbox" data-select-all>选择已加载记录</label><span data-selected-count class="collections-source"></span></div><p role="status" data-list-status class="collections-status">正在读取收藏…</p><button type="button" data-retry-list hidden>重新加载</button><div class="collections-records"></div><button type="button" data-more hidden>加载更多</button>`;
  let items = [],
    total = 0,
    query = "",
    kind = "",
    filterBook = bookId,
    grouped = false,
    loading = false,
    generation = 0,
    requestScope,
    timer;
  const selected = new Set(),
    books = new Map(),
    records = $(".collections-records", root),
    status = $("[data-list-status]", root);
  const bookSelect = $("[data-book]", root),
    more = $("[data-more]", root),
    retry = $("[data-retry-list]", root);
  const updateBooks = () => {
    if (!bookSelect) return;
    bookSelect.innerHTML =
      '<option value="">所有书籍与文章</option>' +
      [...books]
        .map(([id, label]) => `<option value="${e(id)}">${e(label)}</option>`)
        .join("");
    bookSelect.value = filterBook || "";
  };
  const selectionStatus = () => {
    $("[data-selected-count]", root).textContent = selected.size
      ? `已选 ${selected.size} 条`
      : "";
    const all = $("[data-select-all]", root);
    all.checked =
      items.length > 0 && items.every((item) => selected.has(String(item.id)));
    all.indeterminate = selected.size > 0 && !all.checked;
  };
  const card = (item) =>
    `<article class="collections-record" data-record="${e(item.id)}"><div class="collections-card-head"><span class="collections-kind">${item.kind === "word" ? "词语收藏" : "摘录划线"}</span><label class="collections-inline"><input type="checkbox" data-select="${e(item.id)}" ${selected.has(String(item.id)) ? "checked" : ""} aria-label="选择这条收藏"><span class="collections-source">${e(date(item.created_at))}</span></label></div><blockquote class="collections-quote">${e(item.quote)}</blockquote>${item.kind === "word" && contextText(item.context) ? `<p class="collections-context">${e(contextText(item.context))}</p>` : ""}<p class="collections-source">${e(collectionSource(item))}</p>${item.explanation ? `<div class="collections-explanation"><p class="collections-text">${e(explanationText(item.explanation))}</p><small>${e(item.explanation.source)}</small></div>` : ""}${item.my_meaning ? `<p class="collections-personal"><span>我的释义</span> ${e(item.my_meaning)}</p>` : ""}<div class="collections-actions"><button type="button" data-action="preview">回原文</button><button type="button" data-action="edit">我的释义 / 解释</button><button type="button" data-action="delete" class="collections-danger">${item.kind === "word" ? "取消收藏" : "删除整条划线"}</button></div></article>`;
  const render = () => {
    if (grouped) {
      const groups = new Map();
      for (const item of items) {
        const key =
          item.kind === "word"
            ? `word:${item.quote.normalize("NFKC").toLocaleLowerCase()}`
            : `excerpt:${item.id}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      records.innerHTML = [...groups.values()]
        .map(
          (group) =>
            `<section class="collections-group">${group[0].kind === "word" ? `<h3>${e(group[0].quote)} <span class="collections-source">${group.length} 次已加载的语境出现</span></h3>` : ""}${group.map(card).join("")}</section>`,
        )
        .join("");
    } else records.innerHTML = items.map(card).join("");
    if (!items.length)
      records.innerHTML = `<p class="collections-empty">${query || kind || filterBook ? "这个范围内暂无匹配的收藏。" : "阅读时选择“划线”或在词卡选择“收藏词语”，就会在这里留下原句与来源。"}</p>`;
    status.textContent = `已加载 ${items.length} / ${total} 条收藏`;
    more.hidden = items.length >= total;
    more.disabled = loading;
    $("[data-group-note]", root).hidden = !grouped;
    selectionStatus();
  };
  const load = async (append = false) => {
    const current = ++generation;
    requestScope?.dispose();
    requestScope = childScope(scope);
    loading = true;
    retry.hidden = true;
    more.disabled = true;
    status.textContent = "正在读取收藏…";
    const params = new URLSearchParams({
      limit: "50",
      offset: String(append ? items.length : 0),
    });
    if (filterBook) params.set("book_id", filterBook);
    else if (docId) params.set("doc_id", docId);
    if (kind) params.set("kind", kind);
    if (query) params.set("q", query);
    try {
      const result = await store.read(`?${params}`, requestScope);
      if (scope.signal.aborted || current !== generation) return;
      items = append
        ? [
            ...new Map(
              [...items, ...result.items].map((item) => [
                String(item.id),
                item,
              ]),
            ).values(),
          ]
        : result.items;
      total = result.total;
      for (const item of items)
        if (item.book_id)
          books.set(
            String(item.book_id),
            item.book_title || item.title || "书籍",
          );
      for (const id of selected)
        if (!items.some((item) => String(item.id) === id)) selected.delete(id);
      loading = false;
      updateBooks();
      render();
    } catch (error) {
      if (
        scope.signal.aborted ||
        current !== generation ||
        error.name === "AbortError"
      )
        return;
      status.textContent = `收藏暂时无法加载：${error.message}`;
      retry.hidden = false;
    } finally {
      if (current === generation) {
        loading = false;
        more.disabled = false;
      }
    }
  };
  scope.on($("[data-query]", root), "input", (event) => {
    query = event.target.value.trim();
    selected.clear();
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 250);
  });
  scope.on($("[data-kind]", root), "change", (event) => {
    kind = event.target.value;
    selected.clear();
    void load();
  });
  scope.on(bookSelect, "change", (event) => {
    filterBook = event.target.value || null;
    selected.clear();
    void load();
  });
  scope.on($("[data-group]", root), "change", (event) => {
    grouped = event.target.checked;
    render();
  });
  scope.on(more, "click", () => {
    if (!loading) void load(true);
  });
  scope.on(retry, "click", () => void load());
  scope.on($("[data-select-all]", root), "change", (event) => {
    for (const item of items)
      if (event.target.checked) selected.add(String(item.id));
      else selected.delete(String(item.id));
    render();
  });
  scope.on(records, "change", (event) => {
    if (!event.target.matches("[data-select]")) return;
    if (event.target.checked) selected.add(event.target.dataset.select);
    else selected.delete(event.target.dataset.select);
    selectionStatus();
  });
  scope.on(records, "click", async (event) => {
    const button = event.target.closest("[data-action]"),
      entry = button?.closest("[data-record]");
    if (!button || button.disabled) return;
    const item = items.find((item) => String(item.id) === entry.dataset.record);
    if (!item) return;
    if (button.dataset.action === "preview")
      previewCollection(ctx, store, item, scope);
    else if (button.dataset.action === "edit")
      editCollection(ctx, store, item, scope);
    else {
      button.disabled = true;
      try {
        const result = await store.remove(item);
        store.undo(
          result,
          item.kind === "word"
            ? "已取消词语收藏"
            : "已删除整条划线；独立笔记仍保留",
        );
      } catch (error) {
        if (!scope.signal.aborted) toast(error.message);
      } finally {
        button.disabled = false;
      }
    }
  });
  scope.on($("[data-manage]", root), "click", () =>
    manageCollections(store, scope, {
      bookId: filterBook,
      bookTitle: books.get(String(filterBook)) || title,
      selected,
      selectedQuotes: items
        .filter((item) => selected.has(String(item.id)))
        .map((item) => item.quote),
    }),
  );
  scope.on(store.events, "change", (event) => {
    if (event.detail.path === "/resurface") return;
    const updated = event.detail.result.item;
    if (updated && /^\/\d+$/.test(event.detail.path) && !query) {
      items = items.map((item) =>
        String(item.id) === String(updated.id) ? updated : item,
      );
      render();
    } else void load();
  });
  scope.cleanup(() => {
    clearTimeout(timer);
    requestScope?.dispose();
  });
  if (bookSelect)
    void api("/library/books", { signal: scope.signal })
      .then((list) => {
        if (scope.signal.aborted) return;
        for (const book of list)
          if (book.id)
            books.set(String(book.pdf?.book_id ?? book.id), book.title);
        updateBooks();
      })
      .catch(() => {
        /* Saved snapshots still supply source filter choices. */
      });
  void load();
  return scope;
}

export function mountResurface(ctx, store, root, owner) {
  const scope = childScope(store.scope, owner);
  root.classList.add("collections-resurface");
  root.setAttribute("aria-label", "再次遇见");
  let value,
    pending = false,
    generation = 0;
  const render = () => {
    root.innerHTML = !value.enabled
      ? '<div class="collections-heading"><span class="collections-source">再次遇见已关闭</span><button type="button" data-action="show">重新开启</button></div>'
      : value.item
        ? `<div class="collections-heading"><span class="collections-eyebrow">再次遇见 · 你的收藏</span><button type="button" data-action="hide">关闭推荐</button></div><blockquote class="collections-quote">${e(value.item.quote)}</blockquote>${value.item.kind === "word" ? `<p class="collections-context">${e(contextText(value.item.context))}</p>` : ""}<p class="collections-source">${e(collectionSource(value.item))}</p><div class="collections-actions"><button type="button" data-action="preview">回原文</button><button type="button" data-action="next">换一条</button><button type="button" data-action="snooze">这条暂不推荐 · 30 天</button><a href="#/collections">所有收藏</a></div>`
        : `<div class="collections-heading"><span class="collections-eyebrow">再次遇见</span><button type="button" data-action="hide">关闭推荐</button></div><p class="collections-help">${e(value.reason || "目前没有适合再次呈现的收藏。阅读时留下喜欢的词句，它们会在这里再次相遇。")}</p><a href="#/collections">查看收藏</a>`;
    if (pending)
      for (const button of root.querySelectorAll("button"))
        button.disabled = true;
  };
  const load = async () => {
    const current = ++generation;
    try {
      const result = await store.read("/resurface", scope);
      if (scope.signal.aborted || current !== generation) return;
      value = result;
      render();
    } catch (error) {
      if (!scope.signal.aborted && current === generation)
        root.innerHTML =
          '<p class="collections-help">再次遇见暂时无法加载。</p><button type="button" data-action="retry">重试</button>';
    }
  };
  scope.on(root, "click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button || pending) return;
    const action = button.dataset.action;
    if (action === "preview") {
      previewCollection(ctx, store, value.item, scope);
      return;
    }
    if (action === "retry") {
      void load();
      return;
    }
    pending = true;
    generation++;
    render();
    try {
      value = await store.write("/resurface", {
        action,
        ...(value.item ? { id: value.item.id } : {}),
      });
    } catch (error) {
      if (!scope.signal.aborted) toast(error.message);
    } finally {
      pending = false;
      if (!scope.signal.aborted) render();
    }
  });
  scope.on(store.events, "change", (event) => {
    if (event.detail.path === "/resurface") return;
    const deleted =
      event.detail.path.startsWith(`/${value?.item?.id}?`) ||
      event.detail.result.merged_ids?.includes(value?.item?.id) ||
      event.detail.path === "/cleanup";
    if (deleted) {
      value = { ...value, item: null };
      render();
    }
    void load();
  });
  root.innerHTML =
    '<p class="collections-help" role="status">正在读取再次遇见…</p>';
  void load();
  return scope;
}
