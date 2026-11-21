import { $, $$, e, api, local } from "../core.js";

function runLocalSearch(r, query) {
  const hits = [];
  if (query) {
    const regex = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "ig",
    );
    for (const b of r.doc.blocks) {
      for (const m of b.text.matchAll(regex)) {
        hits.push(r.anchorFor(b.id, m.index, m.index + m[0].length));
      }
    }
  }
  return hits;
}

function mountSingleDocSearch(r, el, scope) {
  let hits = [],
    current = -1,
    timer;
  const jump = (step) => {
    if (!hits.length) return;
    current = (current + step + hits.length) % hits.length;
    r.restore(hits[current]);
    $("#find-count", el).textContent = `${current + 1} / ${hits.length} 处`;
  };
  const search = () => {
    r.search = $("#find-text", el).value.trim().slice(0, 120);
    hits = runLocalSearch(r, r.search);
    current = -1;
    r.pages.render();
    $("#find-count", el).textContent = hits.length
      ? `${hits.length} 处`
      : "没有找到匹配";
    if (hits.length) jump(1);
  };
  scope.on($("#find-text", el), "input", () => {
    clearTimeout(timer);
    timer = setTimeout(search, 250);
  });
  scope.on($("#find-text", el), "keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      jump(ev.shiftKey ? -1 : 1);
    }
  });
  scope.on($("#find-prev", el), "click", () => jump(-1));
  scope.on($("#find-next", el), "click", () => jump(1));
  scope.cleanup(() => {
    clearTimeout(timer);
    if (!r.scope.signal.aborted) {
      const a = r.position();
      r.search = "";
      r.pages.render();
      r.restore(a);
    }
  });
  $("#find-text", el).focus();
}

function mountBookSearch(r, bookId, el, scope) {
  const saved = r.ctx.lastBookSearch?.bookId === bookId ? r.ctx.lastBookSearch : null;
  let searchScope = saved?.scope === "current" ? "current" : "book";
  let headingsOnly = Boolean(saved?.headingsOnly);
  let hits = [];
  let current = -1;
  let nextCursor = null;
  let hasMore = false;
  let matchedChapters = 0;
  let lastExecutedQuery = "";
  let timer;
  let requestController = null;
  let navigating = false;

  const input = $("#find-text", el);
  const countEl = $("#find-count", el);
  const coverageEl = $("#find-coverage", el);
  const resultsEl = $("#find-results", el);
  const moreBtn = $("#find-more", el);
  const headingsWrap = $("#find-headings-wrap", el);
  const headingsCheckbox = $("#find-headings-only", el);

  const abortRequest = () => {
    requestController?.abort();
    requestController = null;
  };

  const savePrefs = (query) => {
    r.ctx.lastBookSearch = {
      bookId,
      query,
      scope: searchScope,
      headingsOnly,
    };
  };

  const syncScopeUI = () => {
    $$("[data-search-scope]", el).forEach((btn) => {
      const active = btn.dataset.searchScope === searchScope;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    headingsWrap.hidden = searchScope !== "book";
    headingsCheckbox.checked = headingsOnly;
    if (searchScope !== "book") {
      coverageEl.hidden = true;
      resultsEl.innerHTML = "";
      moreBtn.hidden = true;
    }
  };

  const updateActiveResultUI = () => {
    $$("[data-hit-index]", resultsEl).forEach((btn) => {
      const active = Number(btn.dataset.hitIndex) === current;
      btn.classList.toggle("active", active);
      if (active) btn.scrollIntoView({ block: "nearest" });
    });
  };

  const updateCount = (query) => {
    if (!query) {
      countEl.textContent = "输入后查找";
      return;
    }
    if (!hits.length) {
      countEl.textContent = "没有找到匹配";
      return;
    }
    if (searchScope === "current") {
      countEl.textContent = `${current + 1} / ${hits.length} 处`;
      return;
    }
    const totalLabel = hasMore ? `${hits.length}+` : `${hits.length}`;
    if (current >= 0) {
      countEl.textContent = `${current + 1} / ${totalLabel} 处`;
    } else {
      countEl.textContent = `${totalLabel} 处（涉及 ${matchedChapters} 章）`;
    }
  };

  const renderResults = (query, coverage) => {
    if (searchScope !== "book") {
      coverageEl.hidden = true;
      resultsEl.innerHTML = "";
      moreBtn.hidden = true;
      return;
    }
    if (coverage && coverage.page_count > 0) {
      if (coverage.page_count > coverage.ready_pages) {
        coverageEl.textContent = `已检索已转换的 ${coverage.ready_pages} / ${coverage.page_count} 页`;
        coverageEl.hidden = false;
      } else if (query && hits.length) {
        coverageEl.textContent = `已检索全部 ${coverage.page_count} 页`;
        coverageEl.hidden = false;
      } else {
        coverageEl.hidden = true;
      }
    } else {
      coverageEl.hidden = true;
    }

    resultsEl.innerHTML = hits
      .map((hit, i) => {
        const where =
          hit.page_number != null
            ? `原页 P.${hit.page_number}`
            : `${hit.chapter_idx + 1}. ${hit.chapter_title}`;
        const badges = [
          hit.is_heading ? '<span class="search-heading-badge">标题</span>' : "",
          hit.doc_id === r.doc.id
            ? '<span class="search-current-badge">当前</span>'
            : "",
        ]
          .filter(Boolean)
          .join("");
        const snippet = `${e(hit.snippet_before)}<mark class="search-hit">${e(hit.snippet_match)}</mark>${e(hit.snippet_after)}`;
        return `<button type="button" class="search-result-item ${i === current ? "active" : ""}" role="listitem" data-hit-index="${i}"><span class="search-result-meta"><span>${e(where)}</span><span class="search-result-badges">${badges}</span></span><span class="search-result-snippet">${snippet}</span></button>`;
      })
      .join("");

    moreBtn.hidden = !hasMore;
    moreBtn.disabled = false;
    moreBtn.textContent = "加载更多";
  };

  const activateHit = (index) => {
    if (!hits.length) return;
    const hit = hits[index];
    if (!hit) return;
    current = index;
    if (searchScope === "current") {
      r.restore(hit.anchor);
      updateCount(input.value.trim().slice(0, 120));
      return;
    }
    const query = input.value.trim().slice(0, 120);
    savePrefs(query);
    if (hit.doc_id === r.doc.id) {
      if (r.search !== query) {
        r.search = query;
        r.pages.render();
      }
      r.restore(hit.anchor);
      updateActiveResultUI();
      updateCount(query);
      return;
    }
    navigating = true;
    local.set(`search-highlight:${hit.doc_id}`, query);
    if (!local.set(`jump:${hit.doc_id}`, hit.anchor)) {
      navigating = false;
      return;
    }
    r.ctx.navigate(`#/read/${hit.doc_id}`);
  };

  const jump = (step) => {
    if (!hits.length) return;
    const next =
      current < 0
        ? step > 0
          ? 0
          : hits.length - 1
        : (current + step + hits.length) % hits.length;
    activateHit(next);
  };

  const runSearch = async ({ allowSingleChar = false, append = false } = {}) => {
    const query = input.value.trim().slice(0, 120);
    savePrefs(query);
    if (!append) {
      abortRequest();
      if (searchScope === "current") {
        lastExecutedQuery = query;
        r.search = query;
        hits = runLocalSearch(r, query).map((anchor) => ({
          doc_id: r.doc.id,
          anchor,
        }));
        current = -1;
        nextCursor = null;
        hasMore = false;
        matchedChapters = 0;
        r.pages.render();
        renderResults(query, null);
        if (hits.length) jump(1);
        else updateCount(query);
        return;
      }
      if (!query) {
        hits = [];
        current = -1;
        nextCursor = null;
        hasMore = false;
        matchedChapters = 0;
        lastExecutedQuery = "";
        if (r.search) {
          r.search = "";
          r.pages.render();
        }
        renderResults("", null);
        updateCount("");
        return;
      }
      if (query.length === 1 && !allowSingleChar) {
        hits = [];
        current = -1;
        nextCursor = null;
        hasMore = false;
        matchedChapters = 0;
        lastExecutedQuery = "";
        renderResults("", null);
        countEl.textContent = "输入至少 2 个字符，或按回车搜索";
        return;
      }
      countEl.textContent = "正在搜索整本书…";
      moreBtn.hidden = true;
    } else {
      if (!hasMore || !nextCursor) return;
      abortRequest();
      moreBtn.disabled = true;
      moreBtn.textContent = "正在加载…";
    }

    const controller = new AbortController();
    requestController = controller;
    const params = new URLSearchParams({
      q: query,
      limit: "30",
    });
    if (headingsOnly) params.set("headings_only", "true");
    if (append && nextCursor) params.set("cursor", nextCursor);

    try {
      const data = await api(
        `/library/books/${encodeURIComponent(bookId)}/search?${params}`,
        { signal: controller.signal },
      );
      if (
        scope.signal.aborted ||
        controller.signal.aborted ||
        requestController !== controller
      )
        return;
      requestController = null;
      lastExecutedQuery = query;
      const incoming = Array.isArray(data.hits) ? data.hits : [];
      hits = append ? [...hits, ...incoming] : incoming;
      hasMore = Boolean(data.has_more);
      nextCursor = data.next_cursor || null;
      matchedChapters = data.matched_chapters || 0;

      if (!append) {
        current = -1;
        const hasCurrentHit = hits.some((h) => h.doc_id === r.doc.id);
        const nextHighlight = hasCurrentHit ? query : "";
        if (r.search !== nextHighlight) {
          r.search = nextHighlight;
          r.pages.render();
        }
        renderResults(query, data.coverage);
        if (hits[0]?.doc_id === r.doc.id) {
          current = 0;
          r.restore(hits[0].anchor);
          updateActiveResultUI();
        }
        updateCount(query);
      } else {
        renderResults(query, data.coverage);
        updateCount(query);
      }
    } catch (err) {
      if (err.name === "AbortError" || scope.signal.aborted) return;
      if (requestController === controller) requestController = null;
      if (append) {
        moreBtn.disabled = false;
        moreBtn.textContent = "重试加载";
      } else {
        countEl.textContent = err.message || "搜索失败，请重试";
      }
    }
  };

  scope.on(input, "input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => void runSearch(), 250);
  });
  scope.on(input, "keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      clearTimeout(timer);
      const q = input.value.trim().slice(0, 120);
      if (q !== lastExecutedQuery) {
        void runSearch({ allowSingleChar: true });
      } else {
        jump(ev.shiftKey ? -1 : 1);
      }
    }
  });
  scope.on($("#find-prev", el), "click", () => jump(-1));
  scope.on($("#find-next", el), "click", () => jump(1));
  scope.on(el, "click", (ev) => {
    const scopeBtn = ev.target.closest("[data-search-scope]");
    if (scopeBtn) {
      const nextScope = scopeBtn.dataset.searchScope;
      if (nextScope === searchScope) return;
      clearTimeout(timer);
      abortRequest();
      searchScope = nextScope;
      syncScopeUI();
      void runSearch({ allowSingleChar: true });
      return;
    }
    const hitBtn = ev.target.closest("[data-hit-index]");
    if (hitBtn) {
      activateHit(Number(hitBtn.dataset.hitIndex));
    }
  });
  scope.on(headingsCheckbox, "change", () => {
    clearTimeout(timer);
    abortRequest();
    headingsOnly = headingsCheckbox.checked;
    void runSearch({ allowSingleChar: true });
  });
  scope.on(moreBtn, "click", () => {
    void runSearch({ allowSingleChar: true, append: true });
  });
  scope.cleanup(() => {
    clearTimeout(timer);
    abortRequest();
    if (!navigating && !r.scope.signal.aborted) {
      const a = r.position();
      r.search = "";
      r.pages.render();
      r.restore(a);
    }
  });

  syncScopeUI();
  if (saved?.query) {
    input.value = saved.query;
    void runSearch({ allowSingleChar: true });
  }
  input.focus();
}

export function install(ctx) {
  return ctx.hook("read", (r) =>
    r.tool("search", "搜索", () => {
      const bookId = r.doc.pdf?.book_id ?? r.doc.chapter?.book_id ?? null;
      const hasBookScope = Boolean(
        bookId != null && (r.doc.pdf || (r.doc.chapters?.length || 0) > 1),
      );
      if (!hasBookScope) {
        return r.panel(
          "search",
          "在这一篇中查找",
          '<label for="find-text">关键词或短语</label><input type="search" id="find-text" placeholder="输入英文…"><div class="row gap"><button id="find-prev" aria-label="上一个搜索结果">↑</button><span class="meta" id="find-count">输入后查找</span><button id="find-next" aria-label="下一个搜索结果">↓</button></div>',
          (el, scope) => mountSingleDocSearch(r, el, scope),
        );
      }
      return r.panel(
        "search",
        "书内搜索",
        '<div class="search-scope" role="group" aria-label="搜索范围"><button type="button" data-search-scope="book" aria-pressed="true" class="active">全书</button><button type="button" data-search-scope="current" aria-pressed="false">当前篇</button><label class="search-headings-filter" id="find-headings-wrap"><input type="checkbox" id="find-headings-only"><span>仅标题</span></label></div><label for="find-text">关键词或短语</label><input type="search" id="find-text" placeholder="输入关键词或标题…"><div class="row gap"><button id="find-prev" aria-label="上一个搜索结果">↑</button><span class="meta" id="find-count">输入后查找</span><button id="find-next" aria-label="下一个搜索结果">↓</button></div><p class="meta search-coverage" id="find-coverage" hidden></p><div class="search-results" id="find-results" role="list"></div><button type="button" class="text-button search-more" id="find-more" hidden>加载更多</button>',
        (el, scope) => mountBookSearch(r, bookId, el, scope),
      );
    }),
  );
}
