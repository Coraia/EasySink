const API = "/api/pdf-lab";
const PDFJS_VERSION = "6.4.299";
const PDFJS_ROOT = new URL(`./vendor/pdfjs-${PDFJS_VERSION}/`, import.meta.url);
const MAX_CANVAS_PIXELS = 16_000_000;
const PREFS_KEY = "wise-reader:pdf-lab:prefs:v1";
const RESUME_KEY = "wise-reader:pdf-lab:resume:v1";
const $ = (id) => document.getElementById(id);
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const bookPath = (id, suffix = "") =>
  `${API}/books/${encodeURIComponent(id)}${suffix}`;

function loadStored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function saveStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Reading still works without browser storage. */
  }
}
const prefs = loadStored(PREFS_KEY, {});
const resumes = loadStored(RESUME_KEY, {});
const state = {
  books: [],
  capabilities: null,
  shelfSignature: "",
  shelfTimer: null,
  shelfBusy: false,
  generation: 0,
  controller: null,
  pollTimer: null,
  book: null,
  task: null,
  detail: null,
  refreshPromise: null,
  navigationRevision: 0,
  rangeStates: new Map(),
  resumeWritable: false,
  restorePending: false,
  restoreToken: 0,
  refreshGeneration: null,
  refreshPage: null,
  refreshAgain: false,
  result: null,
  pendingResult: null,
  resultKey: null,
  readingSignature: null,
  view: "reading",
  readingPage: 1,
  originalPage: 1,
  readingGeneration: 0,
  fontSize: Math.max(16, Math.min(34, Number(prefs.font_size) || 22)),
  pdfModule: null,
  pdfLoading: null,
  pdfPromise: null,
  pdfDocument: null,
  renderTask: null,
  renderGeneration: 0,
  zoom: 1,
  rotation: 0,
  sourceTarget: null,
  returnAnchor: null,
  selectedSource: null,
  pointerActive: false,
  operationBusy: false,
  importBusy: false,
  importedBookId: null,
  importSession: 0,
  uploadController: null,
  toastTimer: null,
  resumeTimer: null,
};
const events = [];
const firstOriginal = new Set();
const firstReading = new Set();
const taskEnds = new Set();
let droppedEvents = 0;

function metric(event, fields = {}) {
  const entry = {
    event,
    timestamp: new Date().toISOString(),
    performance_ms: Math.round(performance.now() * 100) / 100,
    book_id: state.book?.id ?? null,
    ...fields,
  };
  if (events.length === 2000) {
    events.shift();
    droppedEvents += 1;
  }
  events.push(entry);
  window.dispatchEvent(
    new CustomEvent("pdf-lab:metric", { detail: { ...entry } }),
  );
  if ($("details-dialog").open) renderMeasurements();
  return entry;
}
Object.defineProperty(window, "pdfLabEvidence", {
  value: Object.freeze({
    snapshot: () => ({
      schema_version: 1,
      pdfjs_version: PDFJS_VERSION,
      dropped_events: droppedEvents,
      events: events.map((e) => ({ ...e })),
    }),
  }),
  writable: false,
});

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}
function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.setAttribute("aria-hidden", "true");
  svg.append(use);
  return svg;
}
function button(label, action, className = "secondary") {
  const element = node("button", className, label);
  element.type = "button";
  if (action) element.dataset.action = action;
  return element;
}
function notice(id, message, tone = "info") {
  const element = $(id);
  element.textContent = message;
  element.dataset.tone = tone;
  element.hidden = !message;
}
function toast(message) {
  clearTimeout(state.toastTimer);
  $("toast").textContent = message;
  $("toast").hidden = false;
  state.toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 5000);
}
function errorMessage(error) {
  if (error?.name === "AbortError") return "";
  return error?.message || "请求失败，请刷新后核对书架与任务状态。";
}
function detailMessage(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((item) => item.msg || item.message || item.type || "请求无效")
      .join("；");
  if (detail && typeof detail === "object")
    return (
      detail.message ||
      detail.reason ||
      detail.missing_reason ||
      detail.code ||
      JSON.stringify(detail)
    );
  return "";
}
async function request(url, options = {}) {
  const controller = new AbortController();
  const relay = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) relay();
  else options.signal?.addEventListener("abort", relay, { once: true });
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException(
          "服务响应超时，请核对书架与任务状态。",
          "TimeoutError",
        ),
      ),
    options.timeout ?? 20000,
  );
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(
        detailMessage(body?.detail) || `实验服务返回 ${response.status}。`,
      );
      error.status = response.status;
      throw error;
    }
    if (!body || typeof body !== "object")
      throw new Error("实验服务没有返回有效 JSON。");
    return body;
  } catch (error) {
    if (controller.signal.reason?.name === "TimeoutError")
      throw controller.signal.reason;
    if (error instanceof TypeError)
      throw new Error("无法连接实验服务。请确认独立服务已启动，然后刷新。", {
        cause: error,
      });
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", relay);
  }
}
function current(generation) {
  return generation === state.generation && !!state.book;
}
function validCount(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}
function pageCount() {
  return (
    validCount(state.pdfDocument?.numPages) ||
    validCount(state.book?.page_count) ||
    validCount(state.result?.page_count) ||
    validCount(state.task?.total_pages)
  );
}
function taskState(task = state.task) {
  return task?.state || state.book?.status || "registered";
}
function stateLabel(value) {
  return (
    {
      registered: "原件已保存",
      imported: "原件已保存",
      received: "原件已保存",
      pending: "等待转换",
      queued: "等待转换",
      running: "本机转换中",
      converting: "本机转换中",
      completed: "转换已结束",
      complete: "转换已结束",
      ready: "已有转换结果",
      partial: "部分转换完成",
      partial_completed: "部分转换完成",
      waiting_model: "等待本机模型",
      model_not_ready: "本机模型未准备",
      waiting_resources: "等待本机资源",
      unavailable: "本机引擎未准备",
      paused: "转换已暂停",
      cancelled: "转换已取消",
      canceled: "转换已取消",
      failed: "转换失败",
      interrupted: "转换已中断",
    }[value] || `任务状态：${value}`
  );
}
function taskIsActive() {
  return ["queued", "pending", "running", "converting"].includes(taskState());
}
function pages(result = state.result) {
  return Array.isArray(result?.pages) ? result.pages : [];
}
function pageResult(number = state.readingPage, result = state.result) {
  return pages(result).find((page) => page.page_number === number);
}
function readyPageNumbers() {
  return pages()
    .map((p) => p.page_number)
    .sort((a, b) => a - b);
}
function pageIsRejected(page) {
  return (
    ["rejected", "invalid", "failed"].includes(page?.status) ||
    ["rejected", "invalid", "failed"].includes(page?.quality_status) ||
    ["rejected", "invalid", "failed"].includes(page?.quality_state)
  );
}
function hasContent(page) {
  return (
    !pageIsRejected(page) &&
    (Boolean(page?.text?.trim()) ||
      (Array.isArray(page?.blocks) &&
        page.blocks.some(
          (b) =>
            b.text?.trim() ||
            ["image", "image_fallback", "formula", "table"].includes(b.type),
        )))
  );
}
function readingSummary() {
  const numbers = readyPageNumbers();
  const total = pageCount();
  const readable = pages().filter(hasContent).length;
  return `已载入 ${numbers.length} 个原页范围 · 当前可呈现 ${readable} 页${total ? ` / 全书 ${total} 原页` : ""} · 质量待核对`;
}
function safeResource(value, id = state.book?.id) {
  if (typeof value !== "string" || !id) return null;
  try {
    const url = new URL(value, location.origin);
    const prefix = `${bookPath(id)}/`;
    if (
      url.origin !== location.origin ||
      !url.pathname.startsWith(prefix) ||
      url.username ||
      url.password
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

async function refreshCapabilities() {
  try {
    state.capabilities = await request(`${API}/capabilities`);
    renderCapabilities();
    renderEngineOptions();
  } catch (error) {
    $("capability-summary").textContent = "暂不可读取";
    $("capability-list").replaceChildren(node("li", "", errorMessage(error)));
  }
}
function renderCapabilities() {
  const adapters = Array.isArray(state.capabilities?.adapters)
    ? state.capabilities.adapters
    : [];
  const available = adapters.filter((a) => a.available);
  $("capability-summary").textContent = available.length
    ? `${available.length} 个可用`
    : "等待本机引擎准备";
  $("capability-list").replaceChildren(
    ...adapters.map((adapter) => {
      const item = node("li");
      item.append(
        node("strong", "", adapter.label || adapter.id),
        node("span", "", adapter.available ? "可用" : "暂不可用"),
      );
      item.append(
        node(
          "small",
          "",
          [
            adapter.version ? `版本 ${adapter.version}` : null,
            adapter.supports_ocr
              ? "支持 OCR（质量另行核对）"
              : "不提供扫描 OCR",
            !adapter.available ? detailMessage(adapter.missing_reason) : null,
          ]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      return item;
    }),
  );
  if (!adapters.length)
    $("capability-list").append(node("li", "", "服务尚未提供可用引擎信息。"));
}
async function refreshShelf() {
  if (state.shelfBusy) return;
  state.shelfBusy = true;
  try {
    const data = await request(`${API}/books`);
    if (!Array.isArray(data.books))
      throw new Error("书架响应缺少 books 列表。");
    state.books = data.books;
    renderShelf();
    notice("connection-status", "已连接独立实验书架 · 转换与原版显示分别记录");
  } catch (error) {
    notice("connection-status", errorMessage(error), "error");
  } finally {
    state.shelfBusy = false;
    clearTimeout(state.shelfTimer);
    if (!state.book && !document.hidden)
      state.shelfTimer = setTimeout(refreshShelf, 5000);
  }
}
function renderShelf() {
  const signature = JSON.stringify(state.books);
  if (signature === state.shelfSignature) return;
  state.shelfSignature = signature;
  $("books").replaceChildren(
    ...state.books.map((book) => {
      const card = button("", "open-book", "book-card");
      card.dataset.bookId = book.id;
      card.setAttribute("aria-label", `打开 ${book.title || "PDF 书籍"}`);
      const mark = icon("book");
      mark.classList.add("book-mark");
      card.append(mark, node("h3", "", book.title || "PDF 书籍"));
      card.append(
        node(
          "p",
          "",
          [
            stateLabel(book.status || "registered"),
            validCount(book.page_count)
              ? `${book.page_count} 原页`
              : "页数读取中",
          ].join(" · "),
        ),
      );
      const action = node("span", "card-action", "打开书籍");
      action.append(icon("next"));
      card.append(action);
      return card;
    }),
  );
  $("empty-shelf").hidden = !!state.books.length;
}

function cancelOriginal() {
  state.renderGeneration += 1;
  const render = state.renderTask;
  state.renderTask = null;
  if (render) {
    render.cancel();
    render.promise.catch(() => {});
  }
  $("original-page").hidden = true;
  $("original-page").replaceChildren();
}
function disposePDF() {
  cancelOriginal();
  const loading = state.pdfLoading;
  state.pdfLoading = null;
  state.pdfPromise = null;
  state.pdfDocument = null;
  if (loading) loading.destroy().catch(() => {});
}
function endRoute() {
  clearTimeout(state.pollTimer);
  clearTimeout(state.shelfTimer);
  clearTimeout(state.resumeTimer);
  state.controller?.abort();
  state.controller = null;
  state.generation += 1;
  state.refreshAgain = false;
  state.resumeWritable = false;
  state.restorePending = false;
  state.restoreToken += 1;
  state.readingGeneration += 1;
  disposePDF();
  state.selectedSource = null;
  state.pointerActive = false;
  $("selection-menu").hidden = true;
}
async function openBook(id, preferredView) {
  if (!id) return;
  saveResume();
  endRoute();
  state.book = { id };
  state.navigationRevision = 0;
  state.rangeStates.clear();
  state.task = null;
  state.detail = null;
  state.result = null;
  state.pendingResult = null;
  state.resultKey = null;
  state.readingSignature = null;
  state.returnAnchor = null;
  state.sourceTarget = null;
  state.zoom = 1;
  state.rotation = 0;
  state.operationBusy = false;
  state.controller = new AbortController();
  const generation = state.generation;
  state.readingPage = Math.max(1, Number(resumes[id]?.page_number) || 1);
  state.originalPage = state.readingPage;
  $("library").hidden = true;
  $("reader").hidden = false;
  $("reader").dataset.focus = "true";
  $("reading-tools").hidden = true;
  $("tools-toggle").setAttribute("aria-expanded", "false");
  $("original-zoom").value = "1";
  $("book-title").textContent = "正在打开…";
  $("reading-content").replaceChildren(
    node("div", "view-message", "正在读取书籍与转换范围…"),
  );
  $("reading-scroll").scrollTop = 0;
  notice("reader-notice", "");
  setViewShell("reading");
  metric("book_open_requested", { book_id: id });
  await refreshBook(generation, {
    first: true,
    preferredView,
    initialRevision: state.navigationRevision,
  });
}
function returnToShelf() {
  saveResume();
  endRoute();
  state.book = null;
  state.task = null;
  state.result = null;
  state.pendingResult = null;
  $("reader").hidden = true;
  $("library").hidden = false;
  if ($("details-dialog").open) $("details-dialog").close();
  refreshShelf();
}
function validateResult(result) {
  if (result?.schema_version !== 1 || !Array.isArray(result.pages))
    throw new Error("阅读结果版本暂不支持；原版仍可核对。");
  const seen = new Set();
  for (const page of result.pages) {
    if (
      !Number.isInteger(page.page_number) ||
      page.page_number < 1 ||
      seen.has(page.page_number)
    )
      throw new Error("转换结果的原页范围无效，暂不显示正文。");
    if (validCount(result.page_count) && page.page_number > result.page_count)
      throw new Error("转换结果包含越界原页，暂不显示正文。");
    seen.add(page.page_number);
  }
  return result;
}
function refreshBook(generation, options = {}) {
  if (state.refreshPromise && state.refreshGeneration === generation) {
    if (state.readingPage !== state.refreshPage) state.refreshAgain = true;
    return state.refreshPromise;
  }
  clearTimeout(state.pollTimer);
  state.refreshGeneration = generation;
  state.refreshPage = state.readingPage;
  state.refreshAgain = false;
  if (!pageResult()) {
    state.rangeStates.set(state.readingPage, "loading");
    if (!options.first) renderReading();
  }
  const promise = performBookRefresh(generation, options);
  state.refreshPromise = promise;
  promise.finally(() => {
    if (state.refreshPromise !== promise) return;
    state.refreshPromise = null;
    if (
      current(generation) &&
      state.refreshAgain &&
      !state.operationBusy &&
      !document.hidden
    ) {
      clearTimeout(state.pollTimer);
      state.pollTimer = setTimeout(() => refreshBook(generation), 0);
    }
  });
  return promise;
}
async function performBookRefresh(
  generation,
  { first = false, preferredView, initialRevision } = {},
) {
  let requestedRange = null;
  try {
    const detail = await request(bookPath(state.book.id), {
      signal: state.controller.signal,
    });
    if (!current(generation)) return;
    if (!detail.book?.id || detail.book.id !== state.book.id)
      throw new Error("服务返回的书籍身份不一致。");
    let task = detail.task;
    if (task?.id)
      task = await request(`${API}/tasks/${encodeURIComponent(task.id)}`, {
        signal: state.controller.signal,
      });
    if (!current(generation)) return;
    state.detail = detail;
    state.book = detail.book;
    state.task = task || null;
    const count = pageCount();
    if (count && first && state.navigationRevision === initialRevision) {
      state.readingPage = Math.min(state.readingPage, count);
      state.originalPage = Math.min(state.originalPage, count);
    }
    const rangeStart = Math.max(1, state.readingPage - 1);
    const rangeEnd = Math.min(
      pageCount() || state.readingPage,
      state.readingPage + 1,
    );
    const key = JSON.stringify([
      task?.id,
      task?.state,
      task?.done_pages,
      task?.updated_at,
      detail.result_url,
      detail.reading_ready,
      rangeStart,
      rangeEnd,
    ]);
    if (detail.result_url || detail.reading_ready || task?.done_pages > 0) {
      if (first || key !== state.resultKey) {
        const url = detail.result_url
          ? safeResource(detail.result_url)
          : bookPath(state.book.id, "/result");
        if (!url) throw new Error("阅读结果地址不属于当前书籍，暂不读取。");
        const rangeURL = new URL(url, location.origin);
        rangeURL.searchParams.set("start_page", String(rangeStart));
        rangeURL.searchParams.set("end_page", String(rangeEnd));
        requestedRange = [rangeStart, rangeEnd];
        const result = validateResult(
          await request(rangeURL.href, { signal: state.controller.signal }),
        );
        if (!current(generation)) return;
        for (let number = rangeStart; number <= rangeEnd; number += 1)
          state.rangeStates.set(
            number,
            result.pages.some((page) => page.page_number === number)
              ? "available"
              : "empty",
          );
        state.resultKey = key;
        publishResult(result);
      }
    } else {
      state.rangeStates.set(state.readingPage, "empty");
      if (state.view === "reading") renderReading();
    }
    if (!current(generation)) return;
    if (first && state.navigationRevision === initialRevision) {
      const preferred =
        preferredView || (pages().some(hasContent) ? "reading" : "original");
      setView(preferred, { restore: true, automatic: true });
    } else if (first && state.view === "original") {
      renderOriginal();
    }
    updateReaderChrome();
    if (
      ["completed", "complete"].includes(task?.state) &&
      !taskEnds.has(task.id)
    ) {
      taskEnds.add(task.id);
      metric("conversion_end_observed", {
        task_id: task.id,
        done_pages: task.done_pages,
        total_pages: task.total_pages,
        server_metrics: task.metrics || null,
        quality_verified: false,
      });
    }
    notice("reader-notice", "");
  } catch (error) {
    if (!current(generation) || error.name === "AbortError") return;
    notice("reader-notice", errorMessage(error), "error");
    if (
      !requestedRange ||
      (state.readingPage >= requestedRange[0] &&
        state.readingPage <= requestedRange[1])
    )
      state.rangeStates.set(state.readingPage, "error");
    metric("book_refresh_failed", {
      error: errorMessage(error),
      http_status: error.status ?? null,
    });
    if (first) {
      $("book-title").textContent = state.book?.title || "PDF 书籍";
      renderReading(true);
      if (
        preferredView === "original" &&
        state.book.source_url &&
        state.navigationRevision === initialRevision
      )
        setView("original", { automatic: true });
    }
  } finally {
    if (current(generation) && !document.hidden && !state.operationBusy)
      state.pollTimer = setTimeout(
        () => refreshBook(generation),
        taskIsActive() ? 1500 : 5000,
      );
  }
}
function hasSelection() {
  const selection = window.getSelection();
  return (
    !!selection &&
    !selection.isCollapsed &&
    $("reading-content").contains(selection.anchorNode)
  );
}
function publishResult(result) {
  const loaded = new Map(pages().map((page) => [page.page_number, page]));
  // The response describes only its requested range. Remove stale pages inside
  // that range, while retaining at most six nearby source ranges in memory.
  const requested = result.requested_range;
  if (requested)
    for (const number of loaded.keys())
      if (number >= requested.start_page && number <= requested.end_page)
        loaded.delete(number);
  for (const page of pages(result)) loaded.set(page.page_number, page);
  result = {
    ...result,
    pages: Array.from(loaded.values())
      .sort(
        (a, b) =>
          Math.abs(a.page_number - state.readingPage) -
          Math.abs(b.page_number - state.readingPage),
      )
      .slice(0, 6)
      .sort((a, b) => a.page_number - b.page_number),
  };
  const oldPage = pageResult();
  const newPage = pageResult(state.readingPage, result);
  const changed = JSON.stringify(oldPage) !== JSON.stringify(newPage);
  if (
    state.result &&
    changed &&
    (hasSelection() || state.pointerActive || state.view === "original")
  ) {
    state.pendingResult = result;
    return;
  }
  const anchor = captureAnchor();
  state.result = result;
  state.pendingResult = null;
  if (state.view === "reading") {
    renderReading(changed);
    if (anchor && changed) restoreAnchor(anchor);
  }
}
function applyPendingResult() {
  if (
    !state.pendingResult ||
    hasSelection() ||
    state.pointerActive ||
    state.view !== "reading"
  )
    return;
  publishResult(state.pendingResult);
  updateReaderChrome();
}
function setViewShell(view) {
  state.view = view;
  $("reader").dataset.view = view;
  $("reading-view").hidden = view !== "reading";
  $("original-view").hidden = view !== "original";
  $("view-reading").setAttribute("aria-pressed", String(view === "reading"));
  $("view-original").setAttribute("aria-pressed", String(view === "original"));
  $("tools-toggle").hidden = view !== "reading";
  if (view !== "reading") $("reading-tools").hidden = true;
}
function setView(view, { restore = false, automatic = false } = {}) {
  if (!state.book) return;
  if (!automatic) state.navigationRevision += 1;
  if (view === "original") {
    if (state.view === "reading" && !state.returnAnchor)
      state.returnAnchor = captureAnchor();
    $("selection-menu").hidden = true;
    setViewShell(view);
    renderOriginal();
  } else {
    const anchor =
      state.returnAnchor || (restore ? resumes[state.book.id] : null);
    if (anchor?.page_number) state.readingPage = anchor.page_number;
    cancelOriginal();
    setViewShell("reading");
    applyPendingResult();
    renderReading();
    recordReadingVisible(pageResult(), state.readingGeneration);
    if (anchor) restoreAnchor(anchor);
    state.returnAnchor = null;
    state.sourceTarget = null;
    saveResume();
  }
  updateReaderChrome();
}
function updateReaderChrome() {
  if (!state.book) return;
  $("book-title").textContent = state.book.title || "PDF 书籍";
  $("reader-summary").textContent =
    `${stateLabel(taskState())} · ${readingSummary()}`;
  const number =
    state.view === "original" ? state.originalPage : state.readingPage;
  const total = pageCount();
  $("page-number").value = number;
  $("page-number").max = total || "";
  $("page-count").textContent = `/ ${total || "—"}`;
  $("page-prev").disabled = number <= 1;
  $("page-next").disabled = !total || number >= total;
  $("font-size").textContent = state.fontSize;
  $("font-smaller").disabled = state.fontSize <= 16;
  $("font-larger").disabled = state.fontSize >= 34;
  document.documentElement.style.setProperty(
    "--reader-font-size",
    `${state.fontSize}px`,
  );
  if (state.view === "reading")
    $("visible-state").textContent = hasContent(pageResult())
      ? `原页 ${number} · 转换内容待核对`
      : `原页 ${number} · ${["loading", "unloaded"].includes(state.rangeStates.get(number) || "unloaded") ? "范围加载中" : state.rangeStates.get(number) === "error" ? "范围读取失败" : "尚未提供内容"}`;
  $("source-return").hidden = !state.returnAnchor;
  if ($("details-dialog").open) renderTaskDetails();
}

function readingMessage(title, message) {
  const content = node("div", "view-message");
  content.append(
    node("h2", "", title),
    node("p", "", message),
    button("查看这一页的原版", "view-source-page"),
  );
  return content;
}
function renderReading(force = false) {
  if (!state.book) return;
  const page = pageResult();
  const rangeState = state.rangeStates.get(state.readingPage) || "unloaded";
  const signature = `${state.book.id}:${state.readingPage}:${page ? JSON.stringify(page) : rangeState}`;
  if (!force && signature === state.readingSignature) return;
  state.readingSignature = signature;
  const readingGeneration = ++state.readingGeneration;
  const generation = state.generation;
  const content = $("reading-content");
  const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
  if (!page || pageIsRejected(page)) {
    state.resumeWritable = false;
    const title = pageIsRejected(page)
      ? "这一范围尚不适合阅读"
      : rangeState === "loading" || rangeState === "unloaded"
        ? "正在加载原页范围"
        : rangeState === "error"
          ? "这一范围暂不能读取"
          : "阅读版正在准备";
    const message = pageIsRejected(page)
      ? "服务将这一范围标为不可用，原版仍可核对。"
      : rangeState === "loading" || rangeState === "unloaded"
        ? `正在读取原页 ${state.readingPage} 的转换范围。未加载不代表尚未转换。`
        : rangeState === "error"
          ? `原页 ${state.readingPage} 的范围读取失败；请核对上方原因，原版仍可查看。`
          : `${stateLabel(taskState())}。\n服务尚未为原页 ${state.readingPage} 提供转换内容，可先查看原版。${state.task?.error ? `\n${detailMessage(state.task.error)}` : ""}`;
    content.replaceChildren(readingMessage(title, message));
    updateReaderChrome();
    return;
  }
  const nodes = [
    node("div", "range-label", `PDF 原页 ${state.readingPage} · 转换内容`),
  ];
  const blockIds = new Set();
  for (const block of blocks) {
    const canAnchor =
      typeof block.id === "string" && block.id && !blockIds.has(block.id);
    if (canAnchor) blockIds.add(block.id);
    const wrapper = node("section", "reading-block");
    if (canAnchor) wrapper.dataset.blockId = block.id;
    wrapper.dataset.sourcePage = String(
      block.source?.page_number || page.page_number,
    );
    if (["image", "image_fallback", "formula", "table"].includes(block.type)) {
      const figure = node("figure", "content-object");
      const assetURL = safeResource(block.asset_url);
      if (assetURL) {
        const image = node("img");
        image.src = assetURL;
        image.alt =
          block.type === "image_fallback"
            ? "这一来源区域的原图回退"
            : "转换结果保留的来源图像";
        image.loading = "lazy";
        image.decoding = "async";
        image.addEventListener(
          "load",
          async () => {
            await frame();
            if (
              !current(generation) ||
              readingGeneration !== state.readingGeneration ||
              state.view !== "reading" ||
              document.hidden
            )
              return;
            const bounds = image.getBoundingClientRect();
            const view = $("reading-scroll").getBoundingClientRect();
            if (bounds.bottom > view.top && bounds.top < view.bottom)
              metric("reading_asset_visible", {
                page_number: page.page_number,
                block_id: block.id || null,
                type: block.type,
                natural_width: image.naturalWidth,
                natural_height: image.naturalHeight,
                quality_verified: false,
              });
          },
          { once: true },
        );
        image.addEventListener(
          "error",
          () => {
            if (
              !current(generation) ||
              readingGeneration !== state.readingGeneration
            )
              return;
            image.hidden = true;
            figure.prepend(
              node(
                "div",
                "unavailable-resource",
                "图像资源暂不可用，请核对原版。",
              ),
            );
            metric("reading_asset_failed", {
              page_number: page.page_number,
              block_id: block.id || null,
            });
          },
          { once: true },
        );
        figure.append(image);
      } else {
        figure.append(
          node(
            "div",
            "unavailable-resource",
            block.type === "image_fallback"
              ? "这一内容需要原图回退，服务尚未提供可用图像资源。"
              : "服务尚未提供可用结构或图像资源，请核对原版。",
          ),
        );
      }
      if (block.text?.trim())
        figure.append(node("div", "plain-structure", block.text));
      figure.append(
        node(
          "figcaption",
          "",
          block.type === "image_fallback"
            ? "原图回退 · 不计为结构识别成功"
            : ["formula", "table"].includes(block.type)
              ? "结构呈现暂不可用 · 上方文字仅为提取结果"
              : "保留图像 · 来源与内容待核对",
        ),
      );
      wrapper.append(figure);
    } else if (block.text?.trim()) {
      wrapper.append(
        node(block.type === "heading" ? "h2" : "p", "", block.text),
      );
    } else continue;
    const source = button("", "block-source", "block-source");
    source.append(icon("source"));
    source.dataset.blockId = canAnchor ? block.id : "";
    source.setAttribute(
      "aria-label",
      `核对原页 ${block.source?.page_number || page.page_number} 的来源`,
    );
    source.title = "核对原页来源";
    source.disabled = !canAnchor || !validSource(block.source);
    wrapper.append(source);
    nodes.push(wrapper);
  }
  if (!blocks.length && page.text?.trim()) {
    const wrapper = node("section", "reading-block");
    wrapper.dataset.sourcePage = String(page.page_number);
    wrapper.append(
      node("p", "", page.text),
      node(
        "div",
        "range-note",
        "本页只有提取文字，没有对象来源坐标；可按原页核对，区域定位暂不可用。",
      ),
    );
    nodes.push(wrapper);
  }
  if (nodes.length === 1)
    nodes.push(
      readingMessage(
        "这一页尚无可读文字",
        "已完成页处理不等于 OCR 成功。可先查看原版，转换详情中保留实际状态。",
      ),
    );
  nodes.push(
    node(
      "div",
      "range-note",
      "本原页范围的转换内容已提供；文字、顺序及复杂结构仍需核对。其他原页按需加载，尚未生成的范围会单独显示。",
    ),
  );
  content.replaceChildren(...nodes);
  updateReaderChrome();
  recordReadingVisible(page, readingGeneration);
}
function recordReadingVisible(page, readingGeneration) {
  const generation = state.generation;
  const blocks = Array.isArray(page?.blocks) ? page.blocks : [];
  if (hasContent(page)) {
    frame().then(() => {
      if (
        !current(generation) ||
        readingGeneration !== state.readingGeneration ||
        state.view !== "reading" ||
        document.hidden
      )
        return;
      const textCharacters =
        blocks
          .filter(
            (b) =>
              !["image", "image_fallback", "formula", "table"].includes(b.type),
          )
          .reduce((n, b) => n + (b.text?.length || 0), 0) ||
        (!blocks.length ? page.text?.length || 0 : 0);
      const viewport = $("reading-scroll").getBoundingClientRect();
      const visibleText = Array.from(
        $("reading-content").querySelectorAll(
          ".reading-block > p, .reading-block > h2",
        ),
      ).some((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          bounds.height > 0 &&
          bounds.bottom > viewport.top &&
          bounds.top < viewport.bottom &&
          element.textContent.trim()
        );
      });
      if (!state.restorePending) {
        state.resumeWritable = true;
        saveResume();
      }
      const first = !firstReading.has(state.book.id);
      if (textCharacters > 0 && visibleText) firstReading.add(state.book.id);
      metric(
        textCharacters > 0 && visibleText
          ? "reading_text_visible"
          : "reading_fallback_dom_present",
        {
          page_number: page.page_number,
          first_text_range: first && textCharacters > 0 && visibleText,
          text_characters: textCharacters,
          selectable: textCharacters > 0 && visibleText,
          text_visible_in_viewport: !!visibleText,
          quality_verified: false,
        },
      );
    });
  }
}
function readingBlock(id) {
  return Array.from(
    $("reading-content").querySelectorAll("[data-block-id]"),
  ).find((element) => element.dataset.blockId === id);
}
function blockFor(id) {
  return pageResult()?.blocks?.find((block) => block.id === id);
}
function validSource(source) {
  return (
    source &&
    Number.isInteger(source.page_number) &&
    source.page_number > 0 &&
    Array.isArray(source.bbox) &&
    source.bbox.length === 4 &&
    source.bbox.every(Number.isFinite) &&
    source.bbox[0] <= source.bbox[2] &&
    source.bbox[1] <= source.bbox[3]
  );
}
function rangeAtOffset(element, offset) {
  if (!Number.isFinite(offset) || offset < 0) return null;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (remaining <= text.length) {
      const range = document.createRange();
      range.setStart(text, remaining);
      range.collapse(true);
      return range;
    }
    remaining -= text.length;
  }
  return null;
}
function captureTextPoint(element, top) {
  if (!element?.dataset.blockId) return null;
  const selected = state.selectedSource;
  if (
    selected &&
    selected.block_id === element.dataset.blockId &&
    Number.isFinite(selected.text_offset)
  ) {
    const range = rangeAtOffset(element, selected.text_offset);
    if (range)
      return {
        offset: selected.text_offset,
        top_offset: range.getBoundingClientRect().top - top,
      };
  }
  const bounds = element.getBoundingClientRect();
  const x = bounds.left + Math.min(35, bounds.width / 2);
  const y = Math.max(top + 14, bounds.top + 14);
  let caret;
  if (document.caretPositionFromPoint) {
    const point = document.caretPositionFromPoint(x, y);
    if (point) {
      caret = document.createRange();
      caret.setStart(point.offsetNode, point.offset);
      caret.collapse(true);
    }
  } else caret = document.caretRangeFromPoint?.(x, y);
  if (!caret || !element.contains(caret.startContainer)) return null;
  const prefix = caret.cloneRange();
  prefix.selectNodeContents(element);
  prefix.setEnd(caret.startContainer, caret.startOffset);
  return {
    offset: prefix.toString().length,
    top_offset: caret.getBoundingClientRect().top - top,
  };
}
function captureAnchor(preferredId) {
  if (!state.book || state.view !== "reading") return null;
  const scroll = $("reading-scroll");
  const top = scroll.getBoundingClientRect().top + 1;
  const preferred = preferredId ? readingBlock(preferredId) : null;
  const visible =
    preferred ||
    Array.from($("reading-content").querySelectorAll("[data-block-id]")).find(
      (element) => element.getBoundingClientRect().bottom > top,
    );
  const textPoint = visible ? captureTextPoint(visible, top) : null;
  return {
    book_id: state.book.id,
    page_number: state.readingPage,
    block_id: visible?.dataset.blockId || null,
    block_top_offset: visible
      ? visible.getBoundingClientRect().top - top
      : null,
    scroll_top: visible ? null : scroll.scrollTop,
    font_size: state.fontSize,
    result_engine: state.result?.engine || null,
    conversion_task_id: pageResult()?.conversion_task_id || null,
    text_offset: textPoint?.offset ?? null,
    text_top_offset: textPoint?.top_offset ?? null,
  };
}
async function restoreAnchor(anchor) {
  if (
    !anchor ||
    anchor.book_id !== state.book?.id ||
    anchor.page_number !== state.readingPage
  )
    return false;
  const generation = state.generation;
  const readingGeneration = state.readingGeneration;
  const restoreToken = ++state.restoreToken;
  state.restorePending = true;
  state.resumeWritable = false;
  let restored = false;
  try {
    await frame();
    if (
      !current(generation) ||
      readingGeneration !== state.readingGeneration ||
      state.view !== "reading"
    )
      return false;
    const sameConversion =
      !anchor.conversion_task_id ||
      anchor.conversion_task_id === pageResult()?.conversion_task_id;
    const block =
      anchor.block_id && sameConversion ? readingBlock(anchor.block_id) : null;
    const scroll = $("reading-scroll");
    if (block) {
      const textRange = rangeAtOffset(block, anchor.text_offset);
      const textRect = textRange?.getBoundingClientRect();
      if (textRect?.height && Number.isFinite(anchor.text_top_offset))
        scroll.scrollTop +=
          textRect.top -
          scroll.getBoundingClientRect().top -
          1 -
          anchor.text_top_offset;
      else {
        const desiredOffset = Number.isFinite(anchor.block_top_offset)
          ? anchor.block_top_offset
          : 0;
        scroll.scrollTop +=
          block.getBoundingClientRect().top -
          scroll.getBoundingClientRect().top -
          1 -
          desiredOffset;
      }
      restored = true;
    } else if (anchor.block_id) {
      toast(
        "原文对象在当前结果中没有可靠对应，保留原页范围；原位映射暂不可用。",
      );
      metric("anchor_unmapped", {
        block_id: anchor.block_id,
        page_number: anchor.page_number,
      });
    } else {
      scroll.scrollTop = Math.max(0, Number(anchor.scroll_top) || 0);
      restored = hasContent(pageResult());
    }
    return restored;
  } finally {
    if (current(generation) && restoreToken === state.restoreToken) {
      state.restorePending = false;
      state.resumeWritable = restored;
      if (restored) saveResume();
    }
  }
}
function saveResume() {
  if (
    !state.resumeWritable ||
    state.restorePending ||
    (state.view === "reading" && !hasContent(pageResult()))
  )
    return;
  const anchor =
    state.view === "reading" ? captureAnchor() : state.returnAnchor;
  if (!anchor || !state.book?.id) return;
  resumes[state.book.id] = { ...anchor, saved_at: new Date().toISOString() };
  const ids = Object.keys(resumes);
  if (ids.length > 50)
    ids
      .sort((a, b) =>
        (resumes[a].saved_at || "").localeCompare(resumes[b].saved_at || ""),
      )
      .slice(0, ids.length - 50)
      .forEach((id) => {
        delete resumes[id];
      });
  saveStored(RESUME_KEY, resumes);
}
function showSource(id) {
  const block = blockFor(id);
  if (!block || !validSource(block.source)) {
    toast("这一对象没有可靠来源区域，可按原页核对。");
    return;
  }
  state.returnAnchor = captureAnchor(id);
  state.sourceTarget = {
    ...block.source,
    bbox: [...block.source.bbox],
    block_id: block.id,
  };
  state.originalPage = block.source.page_number;
  metric("source_location_requested", {
    page_number: block.source.page_number,
    block_id: block.id,
    bbox: block.source.bbox,
  });
  setView("original");
}
function navigatePage(number) {
  if (!state.book || !Number.isInteger(number)) return;
  const total = pageCount();
  if (number < 1 || (total && number > total)) {
    toast(`原页范围应为 1 至 ${total || "已知页数"}。`);
    updateReaderChrome();
    return;
  }
  state.navigationRevision += 1;
  if (state.view === "original") {
    state.originalPage = number;
    if (state.sourceTarget?.page_number !== number) state.sourceTarget = null;
    renderOriginal();
  } else {
    saveResume();
    state.restoreToken += 1;
    state.restorePending = false;
    state.resumeWritable = false;
    window.getSelection()?.removeAllRanges();
    state.selectedSource = null;
    $("selection-menu").hidden = true;
    state.readingPage = number;
    state.returnAnchor = null;
    state.sourceTarget = null;
    applyPendingResult();
    renderReading();
    $("reading-scroll").scrollTop = 0;
    saveResume();
    refreshBook(state.generation);
  }
  updateReaderChrome();
}
function changeFont(delta) {
  const anchor = captureAnchor();
  state.fontSize = Math.max(16, Math.min(34, state.fontSize + delta));
  saveStored(PREFS_KEY, { font_size: state.fontSize });
  updateReaderChrome();
  restoreAnchor(anchor);
}

async function loadPDF(generation) {
  if (state.pdfDocument) return state.pdfDocument;
  if (state.pdfPromise) return state.pdfPromise;
  const url = safeResource(state.book?.source_url);
  if (!url) throw new Error("服务尚未提供当前书籍的原件地址。");
  state.pdfPromise = (async () => {
    state.pdfModule ||= await import(new URL("build/pdf.mjs", PDFJS_ROOT).href);
    if (!current(generation))
      throw new DOMException("旧书籍请求已取消", "AbortError");
    const pdfjs = state.pdfModule;
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "build/pdf.worker.mjs",
      PDFJS_ROOT,
    ).href;
    const loading = pdfjs.getDocument({
      url,
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: 65536,
      cMapUrl: new URL("web/cmaps/", PDFJS_ROOT).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("web/standard_fonts/", PDFJS_ROOT).href,
      wasmUrl: new URL("web/wasm/", PDFJS_ROOT).href,
      iccUrl: new URL("web/iccs/", PDFJS_ROOT).href,
      isEvalSupported: false,
      enableXfa: false,
    });
    state.pdfLoading = loading;
    let passwordBlocked = false;
    loading.onPassword = () => {
      passwordBlocked = true;
      loading.destroy().catch(() => {});
    };
    let document;
    try {
      document = await loading.promise;
    } catch (error) {
      if (passwordBlocked)
        throw new DOMException("原件有密码或访问限制", "PasswordException");
      throw error;
    }
    if (!current(generation)) {
      await document.destroy();
      throw new DOMException("旧书籍请求已取消", "AbortError");
    }
    state.pdfDocument = document;
    return document;
  })();
  try {
    return await state.pdfPromise;
  } catch (error) {
    if (current(generation)) {
      state.pdfPromise = null;
      state.pdfLoading = null;
    }
    throw error;
  }
}
function originalError(error) {
  if (error.name === "PasswordException")
    return "这份 PDF 有密码或访问限制，原版暂不能显示。";
  if (error.name === "InvalidPDFException")
    return "原件无法由当前 PDF 查看器读取，请核对文件。";
  if (error.name === "MissingPDFException")
    return "原件资源暂不可取得，请刷新书籍状态。";
  return errorMessage(error);
}
async function renderOriginal() {
  if (!state.book || state.view !== "original") return;
  if (!state.detail) {
    $("original-message").hidden = false;
    $("original-message").textContent = "正在读取书籍与原件信息…";
    return;
  }
  cancelOriginal();
  const renderGeneration = state.renderGeneration;
  const generation = state.generation;
  const number = state.originalPage;
  const started = performance.now();
  const isCurrent = () =>
    current(generation) &&
    state.view === "original" &&
    renderGeneration === state.renderGeneration &&
    number === state.originalPage;
  $("original-message").hidden = false;
  $("original-message").textContent = `正在显示原页 ${number}…`;
  $("visible-state").textContent = "原版渲染中";
  $("source-location").textContent = state.sourceTarget
    ? `原页 ${number} · 等待区域定位`
    : "按需核对 PDF 原页";
  metric("original_requested", {
    page_number: number,
    render_generation: renderGeneration,
  });
  try {
    const pdf = await loadPDF(generation);
    if (!isCurrent()) return;
    if (number > pdf.numPages)
      throw new Error(`原件只有 ${pdf.numPages} 页，当前来源页越界。`);
    const page = await pdf.getPage(number);
    if (!isCurrent()) return;
    const baseViewport = page.getViewport({ scale: 1 });
    const unscaled = page.getViewport({
      scale: 1,
      rotation: (page.rotate + state.rotation) % 360,
    });
    const scroll = $("original-scroll");
    const availableWidth = Math.max(
      160,
      scroll.clientWidth - (innerWidth <= 760 ? 24 : 44),
    );
    const scale = (availableWidth / unscaled.width) * state.zoom;
    const viewport = page.getViewport({
      scale,
      rotation: (page.rotate + state.rotation) % 360,
    });
    const dpr = window.devicePixelRatio || 1;
    const canvas = node("canvas");
    canvas.width = Math.ceil(viewport.width * dpr);
    canvas.height = Math.ceil(viewport.height * dpr);
    if (canvas.width * canvas.height > MAX_CANVAS_PIXELS)
      throw new Error(
        "这一页在当前缩放下超过原版显示像素预算。请缩小后查看，显示清晰度保持设备 DPR。",
      );
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.setAttribute("aria-label", `PDF 原页 ${number}`);
    const render = page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      background: "white",
    });
    state.renderTask = render;
    await render.promise;
    if (!isCurrent()) return;
    state.renderTask = null;
    const renderFinished = performance.now();
    metric("original_canvas_rendered", {
      page_number: number,
      render_generation: renderGeneration,
      elapsed_ms: Math.round((renderFinished - started) * 100) / 100,
      viewport_width: viewport.width,
      viewport_height: viewport.height,
      canvas_width: canvas.width,
      canvas_height: canvas.height,
      dpr,
      intrinsic_rotation: page.rotate,
      additional_rotation: state.rotation,
    });
    const sheet = $("original-page");
    sheet.style.width = `${viewport.width}px`;
    sheet.style.height = `${viewport.height}px`;
    sheet.replaceChildren(canvas);
    sheet.hidden = false;
    $("original-message").hidden = true;
    const highlight = sourceHighlight(baseViewport, viewport, page, sheet);
    await frame();
    await frame();
    if (!isCurrent() || document.hidden) return;
    if (highlight) {
      scroll.scrollTop = Math.max(
        0,
        sheet.offsetTop -
          scroll.offsetTop +
          highlight.offsetTop -
          scroll.clientHeight / 3,
      );
      scroll.scrollLeft = Math.max(
        0,
        highlight.offsetLeft +
          highlight.offsetWidth / 2 -
          scroll.clientWidth / 2,
      );
    } else {
      scroll.scrollTop = 0;
      scroll.scrollLeft = 0;
    }
    await frame();
    if (!isCurrent() || document.hidden) return;
    const highlightBounds = highlight?.getBoundingClientRect();
    const scrollBounds = scroll.getBoundingClientRect();
    const highlightVisible =
      !!highlightBounds &&
      highlightBounds.width > 0 &&
      highlightBounds.height > 0 &&
      highlightBounds.right > scrollBounds.left &&
      highlightBounds.left < scrollBounds.right &&
      highlightBounds.bottom > scrollBounds.top &&
      highlightBounds.top < scrollBounds.bottom;
    if (highlight) $("source-location").textContent = highlightVisible ? `原页 ${number} · 已显示来源区域` : `原页 ${number} · 来源区域未进入视口，请手动核对`;
    const first = !firstOriginal.has(state.book.id);
    firstOriginal.add(state.book.id);
    metric("original_visible", {
      page_number: number,
      render_generation: renderGeneration,
      first_for_book: first,
      elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
      canvas_rendered_at_ms: Math.round(renderFinished * 100) / 100,
      dpr,
      source_highlighted: highlightVisible,
    });
    $("visible-state").textContent = `原页 ${number} 已显示`;
    updateReaderChrome();
    page.cleanup();
  } catch (error) {
    if (
      !isCurrent() ||
      ["RenderingCancelledException", "AbortError"].includes(error.name)
    )
      return;
    $("original-message").textContent = originalError(error);
    $("original-message").hidden = false;
    $("original-page").hidden = true;
    $("visible-state").textContent = "原版尚未显示";
    metric("original_failed", {
      page_number: number,
      render_generation: renderGeneration,
      error: originalError(error),
    });
  }
}
function sourceHighlight(baseViewport, viewport, pdfPage, sheet) {
  const source = state.sourceTarget;
  if (!source || source.page_number !== state.originalPage) return null;
  const resultPage = pageResult(source.page_number);
  const coordinateSpace =
    resultPage?.coordinate_space || state.result?.coordinate_space;
  const bounds = source.bbox;
  const geometryMatches =
    coordinateSpace === "rotated_crop_top_left" &&
    Number.isFinite(resultPage?.width) &&
    Number.isFinite(resultPage?.height) &&
    Math.abs(resultPage.width - baseViewport.width) <= 0.75 &&
    Math.abs(resultPage.height - baseViewport.height) <= 0.75;
  const boxMatches =
    !resultPage?.crop_box ||
    (Array.isArray(resultPage.crop_box) &&
      resultPage.crop_box.length === 4 &&
      resultPage.crop_box.every(
        (v, i) => Number.isFinite(v) && Math.abs(v - pdfPage.view[i]) <= 0.75,
      ));
  const rotationMatches =
    resultPage?.rotation == null || resultPage.rotation === pdfPage.rotate;
  const withinPage =
    validSource(source) &&
    bounds[0] >= -0.75 &&
    bounds[1] >= -0.75 &&
    bounds[2] <= baseViewport.width + 0.75 &&
    bounds[3] <= baseViewport.height + 0.75;
  if (!geometryMatches || !boxMatches || !rotationMatches || !withinPage) {
    $("source-location").textContent =
      `原页 ${source.page_number} · 来源几何无法可靠核对，区域定位暂不可用`;
    metric("source_geometry_unverified", {
      page_number: source.page_number,
      block_id: source.block_id,
      coordinate_space: coordinateSpace || null,
      result_width: resultPage?.width,
      result_height: resultPage?.height,
      pdf_width: baseViewport.width,
      pdf_height: baseViewport.height,
    });
    return null;
  }
  const width = baseViewport.width,
    height = baseViewport.height;
  const rotatePoint = (x, y) => {
    switch (state.rotation) {
      case 90:
        return [height - y, x];
      case 180:
        return [width - x, height - y];
      case 270:
        return [y, width - x];
      default:
        return [x, y];
    }
  };
  const corners = [
    rotatePoint(bounds[0], bounds[1]),
    rotatePoint(bounds[2], bounds[3]),
  ];
  const scale = viewport.width / (state.rotation % 180 ? height : width);
  const highlight = node("div", "source-highlight");
  highlight.style.left = `${Math.max(0, Math.min(corners[0][0], corners[1][0]) * scale)}px`;
  highlight.style.top = `${Math.max(0, Math.min(corners[0][1], corners[1][1]) * scale)}px`;
  highlight.style.width = `${Math.abs(corners[1][0] - corners[0][0]) * scale}px`;
  highlight.style.height = `${Math.abs(corners[1][1] - corners[0][1]) * scale}px`;
  highlight.setAttribute("aria-label", `原页 ${source.page_number} 的来源区域`);
  sheet.append(highlight);
  $("source-location").textContent =
    `原页 ${source.page_number} · 正在将来源区域移入视口`;
  metric("source_region_rendered", {
    page_number: source.page_number,
    block_id: source.block_id,
    bbox: bounds,
    additional_rotation: state.rotation,
    scale,
  });
  return highlight;
}

function openImport() {
  if (!state.importBusy) {
    state.importSession += 1;
    state.importedBookId = null;
    $("import-form").reset();
    $("file-label").textContent = "原件保存在独立实验书架";
    $("import-form").hidden = false;
    $("import-result").hidden = true;
    notice("import-status", "");
  }
  $("import-dialog").showModal();
}
async function importFile(event) {
  event.preventDefault();
  if (state.importBusy) return;
  const file = $("pdf-file").files[0];
  if (!file) return;
  const session = state.importSession;
  state.importBusy = true;
  state.uploadController = new AbortController();
  $("import-submit").disabled = true;
  $("pdf-file").disabled = true;
  notice("import-status", "正在接收原件并保存书籍。接收结果尚未确认…");
  const form = new FormData();
  form.append("file", file);
  const started = performance.now();
  metric("import_requested", { book_id: null, bytes: file.size });
  try {
    const data = await request(`${API}/imports`, {
      method: "POST",
      body: form,
      signal: state.uploadController.signal,
      timeout: 120000,
    });
    if (!data.book?.id)
      throw new Error("导入响应缺少书籍身份，请刷新书架核对接收结果。");
    metric("import_registered", {
      book_id: data.book.id,
      task_id: data.task?.id || null,
      reused: !!data.reused,
      elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
      server_metrics: data.task?.metrics || null,
    });
    await refreshShelf();
    if (session !== state.importSession) return;
    state.importedBookId = data.book.id;
    $("import-form").hidden = true;
    $("import-result").hidden = false;
    $("import-book-title").textContent = data.book.title || "PDF 书籍";
    $("import-book-status").textContent =
      `${stateLabel(data.task?.state || data.book.status || "registered")}。阅读版的可用范围在打开后核对。`;
    notice(
      "import-status",
      data.reused
        ? "这份原件已经在书架，已复用同一书籍。"
        : "原件和书籍已保存，可以关闭这里。",
      "info",
    );
    if (!$("import-dialog").open)
      toast("PDF 已保存在实验书架。刷新即可找到。 ");
  } catch (error) {
    const message = errorMessage(error);
    metric("import_failed_or_unknown", {
      book_id: null,
      elapsed_ms: Math.round((performance.now() - started) * 100) / 100,
      error: message,
      http_status: error.status || null,
    });
    if (session === state.importSession)
      notice(
        "import-status",
        `${message}\n若接收响应中断，请先刷新书架核对已有归属。`,
        "error",
      );
    if (!$("import-dialog").open) toast(message);
    await refreshShelf();
  } finally {
    state.importBusy = false;
    state.uploadController = null;
    $("import-submit").disabled = false;
    $("pdf-file").disabled = false;
  }
}

function supportedActions() {
  return Array.isArray(state.capabilities?.supported_actions)
    ? state.capabilities.supported_actions
    : [];
}
function renderEngineOptions() {
  $("convert-form").hidden = !supportedActions().includes("convert");
  const previous = $("engine-select").value;
  const available = (state.capabilities?.adapters || []).filter(
    (adapter) => adapter.available,
  );
  $("engine-select").replaceChildren(
    ...available.map((adapter) => {
      const option = node("option", "", adapter.label || adapter.id);
      option.value = adapter.id;
      return option;
    }),
  );
  if (available.some((a) => a.id === previous))
    $("engine-select").value = previous;
  if (!available.length) {
    const option = node("option", "", "没有可用的本机引擎");
    option.value = "";
    $("engine-select").append(option);
  }
  engineExplanation();
}
function engineExplanation() {
  const adapter = state.capabilities?.adapters?.find(
    (a) => a.id === $("engine-select").value,
  );
  $("engine-explanation").textContent = adapter
    ? `${adapter.supports_ocr ? "服务声明支持本机 OCR，实际材料质量仍需核对。" : "仅处理真实文字层，不将扫描原图称为 OCR 成功。"} 默认处理原页 1 至全书结束。`
    : "本机模型或依赖尚未准备，已保存的原件仍可查看。";
  $("convert-submit").disabled =
    !adapter?.available ||
    !supportedActions().includes("convert") ||
    taskIsActive() ||
    state.operationBusy;
  $("convert-submit").textContent = taskIsActive()
    ? "转换进行中"
    : state.result
      ? "重新进行本机转换"
      : "开始本机转换";
}
function addDetail(grid, label, value) {
  grid.append(node("dt", "", label), node("dd", "", value ?? "尚未提供"));
}
function renderTaskDetails() {
  if (!state.book) return;
  const grid = node("dl", "detail-grid");
  const numbers = readyPageNumbers();
  const fallbackCount = pages().reduce(
    (n, p) =>
      n + (p.blocks || []).filter((b) => b.type === "image_fallback").length,
    0,
  );
  addDetail(grid, "任务", stateLabel(taskState()));
  addDetail(grid, "原页数", pageCount() || "尚未读取");
  addDetail(
    grid,
    "处理进度",
    `${state.task?.done_pages ?? 0} / ${state.task?.total_pages ?? pageCount() ?? "—"} 原页`,
  );
  addDetail(
    grid,
    "当前载入范围",
    numbers.length ? compactPages(numbers) : "尚未提供",
  );
  addDetail(grid, "内容核对", "转换结束和原图回退均不代表质量校对通过");
  addDetail(grid, "原图回退", `${fallbackCount} 个对象`);
  addDetail(
    grid,
    "拒绝范围",
    `${pages().filter(pageIsRejected).length} 页（仅计服务明确标记）`,
  );
  addDetail(
    grid,
    "实际引擎",
    state.task?.engine || state.result?.engine || "尚未选定",
  );
  if (state.task?.error)
    addDetail(grid, "失败原因", detailMessage(state.task.error));
  addDetail(grid, "处理方式", "当前电脑的本机服务");
  const fragment = document.createDocumentFragment();
  fragment.append(grid);
  if (state.task && Number.isFinite(state.task.done_pages)) {
    const progress = node("progress", "task-progress");
    progress.max =
      state.task.total_pages ||
      pageCount() ||
      Math.max(state.task.done_pages, 1);
    progress.value = state.task.done_pages;
    progress.setAttribute("aria-label", "实际完成页处理进度");
    fragment.append(progress);
  }
  const warnings = [
    ...(state.result?.warnings || []),
    ...pages().flatMap((page) => page.warnings || []),
  ];
  if (warnings.length) {
    const list = node("ul", "detail-warnings");
    warnings
      .slice(0, 30)
      .forEach((warning) =>
        list.append(
          node(
            "li",
            "",
            typeof warning === "string" ? warning : detailMessage(warning),
          ),
        ),
      );
    if (warnings.length > 30)
      list.append(
        node(
          "li",
          "",
          `另有 ${warnings.length - 30} 项警告，保留在服务结果中。`,
        ),
      );
    fragment.append(list);
  }
  $("task-detail").replaceChildren(fragment);
  renderEngineOptions();
  const controls = supportedActions().filter((action) =>
    ["pause", "resume", "cancel"].includes(action),
  );
  $("task-actions").replaceChildren(
    ...controls.map((action) => {
      const control = button(
        { pause: "暂停转换", resume: "继续转换", cancel: "取消这次转换" }[
          action
        ],
        "task-operation",
      );
      control.dataset.operation = action;
      control.disabled =
        state.operationBusy ||
        (action === "resume"
          ? !["paused", "interrupted"].includes(taskState())
          : !taskIsActive());
      return control;
    }),
  );
  renderMeasurements();
}
function compactPages(numbers) {
  const result = [];
  let start = numbers[0],
    end = start;
  for (const number of numbers.slice(1)) {
    if (number === end + 1) end = number;
    else {
      result.push(start === end ? String(start) : `${start}–${end}`);
      start = end = number;
    }
  }
  result.push(start === end ? String(start) : `${start}–${end}`);
  return `原页 ${result.join("、")}`;
}
function renderMeasurements() {
  $("measurement-summary").textContent = JSON.stringify(
    {
      pdfjs_version: PDFJS_VERSION,
      task_metrics: state.task?.metrics || null,
      recent_events: events
        .filter((e) => e.book_id === state.book?.id)
        .slice(-12),
    },
    null,
    2,
  );
}
async function operate(action) {
  if (
    !state.book ||
    state.operationBusy ||
    !supportedActions().includes(action)
  )
    return;
  const generation = state.generation;
  const id = state.book.id;
  state.operationBusy = true;
  renderTaskDetails();
  notice(
    "operation-status",
    action === "convert"
      ? "已请求本机转换，等待实际任务状态…"
      : "正在请求任务操作…",
  );
  try {
    if (state.refreshPromise && state.refreshGeneration === generation)
      await state.refreshPromise;
    if (!current(generation)) return;
    clearTimeout(state.pollTimer);
    const body =
      action === "convert"
        ? {
            action,
            engine: $("engine-select").value,
            start_page: 1,
            end_page: null,
          }
        : { action };
    const data = await request(bookPath(id, "/operations"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: state.controller.signal,
    });
    if (!current(generation)) return;
    metric("task_operation_received", {
      task_id: data.task?.id || null,
      action,
    });
    if (data.book) state.book = data.book;
    if (data.task) state.task = data.task;
    notice(
      "operation-status",
      `服务已接收操作。${stateLabel(taskState())}，已有内容保留。`,
    );
    clearTimeout(state.pollTimer);
    await refreshBook(generation);
  } catch (error) {
    if (!current(generation) || error.name === "AbortError") return;
    notice("operation-status", errorMessage(error), "error");
    metric("task_operation_failed_or_unknown", {
      action,
      error: errorMessage(error),
      http_status: error.status || null,
    });
  } finally {
    if (current(generation)) {
      state.operationBusy = false;
      renderTaskDetails();
      clearTimeout(state.pollTimer);
      state.pollTimer = setTimeout(() => refreshBook(generation), 1500);
    }
  }
}
function exportEvidence() {
  const evidence = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    pdfjs_version: PDFJS_VERSION,
    browser: {
      user_agent: navigator.userAgent,
      viewport_width: innerWidth,
      viewport_height: innerHeight,
      dpr: devicePixelRatio,
    },
    book: state.book
      ? {
          id: state.book.id,
          file_sha256: state.book.file_sha256,
          page_count: state.book.page_count,
        }
      : null,
    task: state.task
      ? {
          id: state.task.id,
          state: state.task.state,
          engine: state.task.engine,
          done_pages: state.task.done_pages,
          total_pages: state.task.total_pages,
          metrics: state.task.metrics,
        }
      : null,
    dropped_events: droppedEvents,
    events,
  };
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(evidence, null, 2)], { type: "application/json" }),
  );
  const link = node("a");
  link.href = url;
  link.download = `pdf-lab-evidence-${Date.now()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function selectionChanged() {
  const selection = window.getSelection();
  if (
    !selection ||
    selection.isCollapsed ||
    state.view !== "reading" ||
    !$("reading-content").contains(selection.anchorNode)
  ) {
    $("selection-menu").hidden = true;
    state.selectedSource = null;
    applyPendingResult();
    return;
  }
  const anchorElement =
    selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection.anchorNode.parentElement;
  const focusElement =
    selection.focusNode?.nodeType === Node.ELEMENT_NODE
      ? selection.focusNode
      : selection.focusNode?.parentElement;
  const start = anchorElement?.closest("[data-block-id]");
  const end = focusElement?.closest("[data-block-id]");
  if (
    !start ||
    start !== end ||
    !validSource(blockFor(start.dataset.blockId)?.source)
  ) {
    $("selection-menu").hidden = true;
    return;
  }
  let textOffset = null;
  try {
    const range = selection.getRangeAt(0).cloneRange();
    range.selectNodeContents(start);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    textOffset = range.toString().length;
  } catch {
    /* Selection can move between events. */
  }
  state.selectedSource = {
    block_id: start.dataset.blockId,
    text_offset: textOffset,
  };
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) {
    $("selection-menu").hidden = true;
    return;
  }
  $("selection-menu").hidden = false;
  $("selection-menu").style.left =
    `${Math.max(10, Math.min(innerWidth - 225, rect.left))}px`;
  $("selection-menu").style.top =
    `${Math.max(10, Math.min(innerHeight - 50, rect.bottom + 8))}px`;
}
function actionClicked(event) {
  const target = event.target.closest("[data-action]");
  if (!target || target.disabled) return;
  switch (target.dataset.action) {
    case "import":
      openImport();
      break;
    case "open-book":
      openBook(target.dataset.bookId);
      break;
    case "block-source":
      showSource(target.dataset.blockId);
      break;
    case "view-source-page":
      state.originalPage = state.readingPage;
      setView("original");
      break;
    case "task-operation":
      operate(target.dataset.operation);
      break;
  }
}
document.addEventListener("click", actionClicked);
$("import-open").addEventListener("click", openImport);
$("import-close").addEventListener("click", () => $("import-dialog").close());
$("import-done").addEventListener("click", () => $("import-dialog").close());
$("import-form").addEventListener("submit", importFile);
$("pdf-file").addEventListener("change", () => {
  $("file-label").textContent =
    $("pdf-file").files[0]?.name || "原件保存在独立实验书架";
});
for (const [id, view] of [
  ["import-read", "reading"],
  ["import-original", "original"],
])
  $(id).addEventListener("click", () => {
    $("import-dialog").close();
    openBook(state.importedBookId, view);
  });
$("library-refresh").addEventListener("click", () => {
  refreshShelf();
  refreshCapabilities();
});
$("reader-back").addEventListener("click", returnToShelf);
$("view-reading").addEventListener("click", () => setView("reading"));
$("view-original").addEventListener("click", () => {
  if (state.view === "original") return;
  state.originalPage = state.readingPage;
  setView("original");
});
$("source-return").addEventListener("click", () => setView("reading"));
$("original-zoom").addEventListener("change", () => {
  state.zoom = Number($("original-zoom").value);
  renderOriginal();
});
$("original-rotate").addEventListener("click", () => {
  state.rotation = (state.rotation + 90) % 360;
  renderOriginal();
});
$("page-prev").addEventListener("click", () =>
  navigatePage(
    (state.view === "original" ? state.originalPage : state.readingPage) - 1,
  ),
);
$("page-next").addEventListener("click", () =>
  navigatePage(
    (state.view === "original" ? state.originalPage : state.readingPage) + 1,
  ),
);
$("page-form").addEventListener("submit", (event) => {
  event.preventDefault();
  navigatePage(Number($("page-number").value));
});
$("tools-toggle").addEventListener("click", () => {
  const open = $("reading-tools").hidden;
  $("reading-tools").hidden = !open;
  $("reader").dataset.focus = String(!open);
  $("tools-toggle").setAttribute("aria-expanded", String(open));
});
$("font-smaller").addEventListener("click", () => changeFont(-2));
$("font-larger").addEventListener("click", () => changeFont(2));
$("details-open").addEventListener("click", () => {
  renderTaskDetails();
  notice("operation-status", "");
  $("details-dialog").showModal();
});
$("details-close").addEventListener("click", () => $("details-dialog").close());
$("engine-select").addEventListener("change", engineExplanation);
$("convert-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!$("convert-submit").disabled) operate("convert");
});
$("evidence-export").addEventListener("click", exportEvidence);
$("selection-menu").addEventListener("pointerdown", (event) =>
  event.preventDefault(),
);
$("selection-source").addEventListener("click", () => {
  if (state.selectedSource) showSource(state.selectedSource.block_id);
});
document.addEventListener("selectionchange", selectionChanged);
$("reading-scroll").addEventListener("pointerdown", () => {
  state.pointerActive = true;
});
const pointerEnd = () => {
  state.pointerActive = false;
  applyPendingResult();
};
window.addEventListener("pointerup", pointerEnd);
window.addEventListener("pointercancel", pointerEnd);
$("reading-scroll").addEventListener(
  "scroll",
  () => {
    $("selection-menu").hidden = true;
    clearTimeout(state.resumeTimer);
    state.resumeTimer = setTimeout(saveResume, 250);
  },
  { passive: true },
);
document.addEventListener("keydown", (event) => {
  if (
    !state.book ||
    $("import-dialog").open ||
    $("details-dialog").open ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.target.closest("input, textarea, select, [contenteditable]")
  )
    return;
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    event.preventDefault();
    navigatePage(
      (state.view === "original" ? state.originalPage : state.readingPage) +
        (event.key === "ArrowRight" ? 1 : -1),
    );
  }
  if (event.key === "Escape" && state.view === "original" && state.returnAnchor)
    setView("reading");
});
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.view === "original" && state.book) renderOriginal();
  }, 180);
});
document.addEventListener("visibilitychange", () => {
  clearTimeout(state.pollTimer);
  clearTimeout(state.shelfTimer);
  if (document.hidden) saveResume();
  else if (state.book) {
    if (!state.controller) return;
    if (!state.operationBusy) refreshBook(state.generation);
    if (state.view === "original") renderOriginal();
  } else refreshShelf();
});
window.addEventListener("pagehide", () => {
  saveResume();
  endRoute();
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  if (state.book) openBook(state.book.id, state.view);
  else refreshShelf();
});
updateReaderChrome();
Promise.allSettled([refreshCapabilities(), refreshShelf()]);
