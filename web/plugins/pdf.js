import { $, $$, Scope, e, local, toast } from "../core.js";
import { imageAnchor } from "./notes.js?v=20261008-pdf";
import { PDFOutline } from "./pdf-outline.js?v=20261008-outline";
import { pdfFailedPageNotice, pdfFallbackPageNotice, pdfImportProgress } from "./pdf-import-progress.js";

const PDFJS = new URL(
  "../prototypes/pdf-lab/vendor/pdfjs-6.4.299/",
  import.meta.url,
);
const MAX_PIXELS = 16_000_000;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const pathFor = (book, suffix = "") =>
  `/pdf/books/${encodeURIComponent(book)}${suffix}`;
let libraryPromise;

async function pdfApi(path, { signal, method = "GET", body } = {}) {
  const response = await fetch(`/api${path}`, {
    signal,
    method,
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.detail;
    const error = new Error(
      typeof detail === "string"
        ? detail
        : detail?.message ||
            detail?.reason ||
            `PDF 服务暂不可用（${response.status}）。`,
    );
    error.status = response.status;
    throw error;
  }
  if (!data || typeof data !== "object")
    throw new Error("PDF 服务没有返回可用状态。");
  return data;
}
function safeURL(value, book, kind) {
  if (typeof value !== "string" || book == null) return null;
  try {
    const url = new URL(value, location.origin);
    const base = `/api/pdf/books/${encodeURIComponent(book)}/`;
    const valid =
      kind === "source"
        ? url.pathname === `${base}source`
        : url.pathname.startsWith(`${base}assets/`);
    return valid &&
      url.origin === location.origin &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function emitMetric(name, data) {
  const event = {
    event: name,
    timestamp: new Date().toISOString(),
    performance_ms: performance.now(),
    ...data,
  };
  window.dispatchEvent(
    new CustomEvent("wise-reader:pdf-metric", { detail: event }),
  );
}
function statusLabel(value) {
  return (
    {
      preparing: "原件已保存",
      registered: "原件已保存",
      queued: "等待转换",
      running: "转换中",
      converting: "转换中",
      completed: "转换已结束",
      paused: "已暂停",
      cancelled: "已取消",
      failed: "转换失败",
      waiting_model: "等待处理模型",
      unavailable: "处理引擎尚未准备",
      partial: "部分内容已生成",
    }[value] ||
    value ||
    "原件已保存"
  );
}
function sourceOf(r, anchor) {
  if (anchor?.pdf_source) return anchor.pdf_source;
  const block = r.doc.blocks.find((b) => b.id === anchor?.block_id);
  return block?.source || null;
}
function objectBlock(block) {
  return (
    block &&
    ["image", "image_fallback", "formula", "table"].includes(block.type)
  );
}
function imageMatchesDoc(r, anchor) {
  if (anchor?.kind !== "image" || !anchor.pdf_source) return true;
  const old = anchor.pdf_source,
    block = r.doc.blocks.find((b) => b.id === anchor.block_id);
  if (
    !objectBlock(block) ||
    !block.source ||
    old.page_number !== block.source.page_number ||
    JSON.stringify(old.bbox) !== JSON.stringify(block.source.bbox)
  )
    return false;
  if (old.source_sha256 && old.source_sha256 !== r.doc.pdf.source_sha256)
    return false;
  const oldURL = safeURL(old.asset_url, r.doc.pdf.book_id, "asset"),
    currentURL = safeURL(block.asset_url, r.doc.pdf.book_id, "asset");
  return oldURL ? oldURL === currentURL : anchor.version === r.doc.version;
}
function actionButton(action, label, disabled = false) {
  return `<button type="button" data-pdf-action="${action}" ${disabled ? "disabled" : ""}>${e(label)}</button>`;
}
function adaptersOf(caps) {
  return Array.isArray(caps?.adapters)
    ? caps.adapters.filter((adapter) => typeof adapter?.id === "string")
    : [];
}
function processingLocation(engine) {
  if (engine === "omarchy") return "你的 Omarchy";
  if (["auto", "digital", "docling"].includes(engine)) return "当前电脑";
  return "位置未确认";
}
function taskProcessing(task, caps) {
  const adapter = adaptersOf(caps).find((item) => item.id === task.engine);
  const failedPageNotice = pdfFailedPageNotice(task);
  const fallbackPageNotice = pdfFallbackPageNotice(task);
  return `<dt>处理位置</dt><dd>${e(processingLocation(task.engine))}</dd>${task.engine ? `<dt>处理引擎</dt><dd>${e(adapter?.label || task.engine)}</dd>` : ""}${fallbackPageNotice ? `<dt>内容提示</dt><dd>${e(fallbackPageNotice)}</dd>` : ""}${failedPageNotice ? `<dt>识别提示</dt><dd>${e(failedPageNotice)}</dd>` : ""}`;
}
const resumableStates = new Set(["paused", "failed", "partial", "preparing"]);
function supportsPageRanges(choice) {
  return choice && choice.id !== "omarchy" && choice.supports_ranges !== false;
}
function wholeBookTask(task, pdf) {
  return task.start_page === 1 && task.end_page === pdf.page_count;
}
function wholeBookAction(task, pdf, engine) {
  if (task.engine === engine && wholeBookTask(task, pdf) && resumableStates.has(task.state))
    return "resume";
  const failed = task.metrics?.conversion_metrics?.failed_pages;
  return task.state === "cancelled" ||
    (task.state === "completed" && Number.isSafeInteger(failed) && failed > 0)
    ? "recognize" : "convert";
}
function wholeBookRequest(task, pdf, engine, caps) {
  const action = wholeBookAction(task, pdf, engine);
  if (!caps?.supported_actions?.includes(action))
    throw new Error("当前服务不支持这项处理操作，请刷新状态。");
  return action === "resume"
    ? { action }
    : { action, engine, start_page: 1, end_page: pdf.page_count };
}
function processingChoices(caps, capabilityError = "") {
  const adapters = adaptersOf(caps),
    automatic = adapters.find((item) => item.id === "auto"),
    digital = adapters.find((item) => item.id === "digital"),
    omarchy = adapters.find((item) => item.id === "omarchy");
  const choices = [
    {
      id: "auto",
      label: "当前电脑 · 自动",
      available: (automatic || digital)?.available === true,
      supports_ranges: automatic?.supports_ranges ?? digital?.supports_ranges,
      missing_reason:
        capabilityError ||
        automatic?.missing_reason ||
        digital?.missing_reason ||
        "当前电脑的转换引擎尚未准备。",
    },
    ...adapters.filter((item) => !["auto", "omarchy"].includes(item.id)),
    omarchy || {
      id: "omarchy",
      available: false,
      missing_reason: capabilityError || "服务尚未提供 Omarchy 处理能力。",
    },
  ];
  return choices.map((item) => ({
    ...item,
    label:
      item.id === "omarchy"
        ? "你的 Omarchy · GPU OCR"
        : item.id === "auto"
          ? item.label
          : `${processingLocation(item.id)} · ${item.label || item.id}`,
    // A new, unknown adapter must not silently become an external destination.
    available:
      ["auto", "digital", "docling", "omarchy"].includes(item.id) &&
      item.available === true,
    missing_reason:
      capabilityError ||
      item.missing_reason ||
      (processingLocation(item.id) === "位置未确认"
        ? "当前界面尚不支持此处理位置。"
        : "此处理引擎暂不可用。"),
  }));
}
function processingPicker(caps, capabilityError = "", ranges = false) {
  const choices = processingChoices(caps, capabilityError);
  const options = choices.map((item) =>
    `<option value="${e(item.id)}" ${item.id === "auto" ? "selected" : ""} ${item.available && (!ranges || supportsPageRanges(item)) ? "" : "disabled"}>${e(item.label)}${ranges && !supportsPageRanges(item) ? "（仅支持整书）" : item.available ? "" : "（不可用）"}</option>`,
  ).join("");
  const unavailable = choices.filter((item) => !item.available).map((item) =>
    `<p class="meta">${e(item.label)}：${e(item.missing_reason)}</p>`,
  ).join("");
  if (ranges)
    return `<label>原页识别位置 <select data-pdf-range-engine>${options}</select></label><p class="meta">Omarchy 当前仅支持整书处理，请使用上方整书入口。</p>`;
  return `<label>整书处理位置 <select data-pdf-engine>${options}</select></label><p class="meta" data-pdf-engine-note></p>${unavailable}<p class="meta" data-pdf-resume-note></p>`;
}
function updateProcessingControls(controls, pdf, task, caps) {
  if (!controls) return;
  const pending = controls.dataset.pdfOperationPending === "true",
    canProcess = pdf.processing_enabled && pdf.lifecycle !== "recycled",
    active = ["queued", "running", "converting"].includes(task.state),
    choices = processingChoices(caps),
    selected = $("[data-pdf-engine]", controls)?.value || "auto",
    choice = choices.find((item) => item.id === selected),
    rangeEngine = $("[data-pdf-range-engine]", controls)?.value,
    rangeChoice = choices.find((item) => item.id === rangeEngine),
    original = choices.find((item) => item.id === task.engine),
    originalRangeAllowed = supportsPageRanges(original) || wholeBookTask(task, pdf);
  for (const input of $$("select,input", controls))
    input.disabled = pending || !canProcess;
  const note = $("[data-pdf-engine-note]", controls);
  if (note)
    note.textContent =
      selected === "omarchy"
        ? "在你的 Omarchy 上识别整书，无付费 API。"
        : processingLocation(selected) === "当前电脑"
          ? "新任务在当前电脑处理。"
          : "此处理位置尚未确认。";
  const resumeNote = $("[data-pdf-resume-note]", controls);
  if (resumeNote)
    resumeNote.textContent = resumableStates.has(task.state)
      ? `继续或重试沿用原任务：${processingLocation(task.engine)}（${task.engine || "引擎未知"}），原页 ${task.start_page ?? "—"}–${task.end_page ?? "—"}，保留成功页。${!originalRangeAllowed ? "该引擎仅支持整书，不能继续此局部任务。" : original?.available ? "" : `暂不可继续：${original?.missing_reason || "原任务引擎尚未确认。"}`}`
      : "";
  for (const button of $$("[data-pdf-action]", controls)) {
    const action = button.dataset.pdfAction;
    if (action === "source") continue;
    let disabled = false;
    if (action === "pause") disabled = !active;
    if (action === "cancel")
      disabled = ![
        "preparing", "queued", "running", "converting", "paused", "interrupted",
      ].includes(task.state);
    if (action === "resume") {
      disabled =
        !canProcess ||
        !resumableStates.has(task.state) ||
        !original?.available || !originalRangeAllowed;
      button.textContent = `${["failed", "partial"].includes(task.state) ? "重试未完成原页" : "继续原任务"}（${processingLocation(task.engine)}）`;
    }
    if (action === "convert") {
      const operation = wholeBookAction(task, pdf, selected);
      disabled = !canProcess || !choice?.available || active ||
        !caps?.supported_actions?.includes(operation);
      button.textContent = operation === "recognize"
        ? "整书重新识别"
        : operation === "resume"
          ? ["failed", "partial"].includes(task.state) ? "重试整书未完成原页" : "继续整书原任务"
          : "准备整书阅读版";
    }
    if (action === "recognize")
      disabled = !canProcess || !rangeChoice?.available ||
        !supportsPageRanges(rangeChoice) || active;
    button.disabled = pending || disabled;
  }
}

class OriginalViewer {
  constructor(owner, book, sourceURL, title, onReturn) {
    this.owner = owner;
    this.book = book;
    this.url = safeURL(sourceURL, book, "source");
    this.title = title;
    this.onReturn = onReturn;
    this.scope = new Scope();
    this.renderToken = 0;
    this.pageNumber = 1;
    this.rotation = 0;
    this.zoom = 1;
    this.closed = false;
    this.target = null;
    this.document = null;
    this.loading = null;
    this.renderTask = null;
    owner.cleanup(() => this.dispose());
  }
  open(source, page = 1) {
    if (this.closed) return;
    this.target = source || null;
    this.pageNumber = source?.page_number || page;
    const dialog = (this.dialog = document.createElement("dialog"));
    dialog.className = "pdf-original-dialog";
    dialog.setAttribute("aria-label", "PDF 原版核对");
    dialog.innerHTML = `<div class="pdf-original-head"><button type="button" data-pdf-return class="text-button">← 回到阅读</button><span>PDF 原版核对 · ${e(this.title)}</span><button type="button" data-pdf-close class="icon-button" aria-label="关闭原版">×</button></div><div class="pdf-original-controls"><form data-pdf-page-form><label>PDF 原页 <input type="number" min="1" value="${this.pageNumber}" data-pdf-page aria-label="跳转 PDF 原页"></label><span data-pdf-total>/ —</span><button>前往</button></form><div class="row"><label>缩放 <select data-pdf-zoom aria-label="原版缩放"><option value="1">适合宽度</option><option value=".75">75%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select></label><button type="button" data-pdf-rotate title="顺时针旋转" aria-label="顺时针旋转">↻</button></div></div><p data-pdf-location class="meta" role="status">正在显示原页…</p><div class="pdf-original-scroll" tabindex="0"><p data-pdf-render-state class="muted" role="status">正在读取原件…</p><div class="pdf-original-sheet" hidden></div></div>`;
    document.body.append(dialog);
    const close = () => dialog.close();
    this.scope.on($("[data-pdf-return]", dialog), "click", close);
    this.scope.on($("[data-pdf-close]", dialog), "click", close);
    this.scope.on(dialog, "close", () => this.dispose(true));
    this.scope.on($("[data-pdf-page-form]", dialog), "submit", (event) => {
      event.preventDefault();
      const page = Number($("[data-pdf-page]", dialog).value);
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        (this.document && page > this.document.numPages)
      )
        return;
      this.pageNumber = page;
      if (this.target?.page_number !== page) this.target = null;
      this.render();
    });
    this.scope.on($("[data-pdf-zoom]", dialog), "change", (event) => {
      this.zoom = Number(event.target.value);
      this.render();
    });
    this.scope.on($("[data-pdf-rotate]", dialog), "click", () => {
      this.rotation = (this.rotation + 90) % 360;
      this.render();
    });
    let resize;
    this.scope.on(window, "resize", () => {
      clearTimeout(resize);
      resize = setTimeout(() => this.render(), 150);
    });
    this.scope.cleanup(() => clearTimeout(resize));
    dialog.showModal();
    this.render();
  }
  valid(token) {
    return (
      !this.closed &&
      !this.owner.signal.aborted &&
      !this.scope.signal.aborted &&
      token === this.renderToken &&
      this.dialog?.open
    );
  }
  async load() {
    if (this.document) return this.document;
    if (this.documentPromise) return this.documentPromise;
    if (!this.url) throw new Error("当前书籍的原件地址暂不可用。");
    this.documentPromise = (async () => {
      const pdfjs = await (libraryPromise ||= import(
        new URL("build/pdf.mjs", PDFJS).href
      ));
      if (this.closed || this.owner.signal.aborted)
        throw new DOMException("已离开原版", "AbortError");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "build/pdf.worker.mjs",
        PDFJS,
      ).href;
      const loading = (this.loading = pdfjs.getDocument({
        url: this.url,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: 65536,
        isEvalSupported: false,
        enableXfa: false,
        cMapUrl: new URL("web/cmaps/", PDFJS).href,
        cMapPacked: true,
        standardFontDataUrl: new URL("web/standard_fonts/", PDFJS).href,
        wasmUrl: new URL("web/wasm/", PDFJS).href,
        iccUrl: new URL("web/iccs/", PDFJS).href,
      }));
      let password = false;
      loading.onPassword = () => {
        password = true;
        loading.destroy().catch(() => {});
      };
      let doc;
      try {
        doc = await loading.promise;
      } catch (error) {
        if (password)
          throw new Error("这份 PDF 有密码或访问限制，原版暂不能显示。");
        throw error;
      }
      if (this.closed || this.owner.signal.aborted) {
        await loading.destroy();
        throw new DOMException("已离开原版", "AbortError");
      }
      this.document = doc;
      return doc;
    })();
    try {
      return await this.documentPromise;
    } catch (error) {
      this.documentPromise = null;
      throw error;
    }
  }
  async render() {
    const token = ++this.renderToken;
    if (!this.valid(token)) return;
    this.renderTask?.cancel();
    this.renderTask?.promise.catch(() => {});
    this.renderTask = null;
    const sheet = $(".pdf-original-sheet", this.dialog),
      message = $("[data-pdf-render-state]", this.dialog),
      location = $("[data-pdf-location]", this.dialog),
      scroll = $(".pdf-original-scroll", this.dialog);
    sheet.replaceChildren();
    sheet.hidden = true;
    message.hidden = false;
    message.textContent = `正在显示原页 ${this.pageNumber}…`;
    location.textContent = this.target ? "正在定位来源区域…" : "核对 PDF 原页";
    const started = performance.now(),
      number = this.pageNumber;
    emitMetric("original_requested", {
      book_id: this.book,
      page_number: number,
      render_token: token,
    });
    let page;
    try {
      const doc = await this.load();
      if (!this.valid(token)) return;
      if (number > doc.numPages)
        throw new Error(`原件共有 ${doc.numPages} 页，来源页越界。`);
      $("[data-pdf-total]", this.dialog).textContent = `/ ${doc.numPages}`;
      $("[data-pdf-page]", this.dialog).max = doc.numPages;
      page = await doc.getPage(number);
      if (!this.valid(token)) return;
      const base = page.getViewport({ scale: 1 });
      const unscaled = page.getViewport({
        scale: 1,
        rotation: (page.rotate + this.rotation) % 360,
      });
      const scale =
        (Math.max(160, scroll.clientWidth - 40) / unscaled.width) * this.zoom;
      const viewport = page.getViewport({
        scale,
        rotation: (page.rotate + this.rotation) % 360,
      });
      const dpr = devicePixelRatio || 1,
        canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width * dpr);
      canvas.height = Math.ceil(viewport.height * dpr);
      if (canvas.width * canvas.height > MAX_PIXELS)
        throw new Error("当前缩放超过原页显示范围，请缩小后查看。");
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.setAttribute("aria-label", `PDF 原页 ${number}`);
      const task = (this.renderTask = page.render({
        canvasContext: canvas.getContext("2d"),
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        background: "white",
      }));
      await task.promise;
      if (!this.valid(token)) return;
      this.renderTask = null;
      emitMetric("original_canvas_rendered", {
        book_id: this.book,
        page_number: number,
        render_token: token,
        elapsed_ms: performance.now() - started,
        canvas_width: canvas.width,
        canvas_height: canvas.height,
        dpr,
        intrinsic_rotation: page.rotate,
        additional_rotation: this.rotation,
      });
      sheet.style.width = `${viewport.width}px`;
      sheet.style.height = `${viewport.height}px`;
      sheet.append(canvas);
      sheet.hidden = false;
      message.hidden = true;
      const highlight = this.highlight(page, base, viewport, sheet);
      await frame();
      await frame();
      if (!this.valid(token) || document.hidden) return;
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
      if (!this.valid(token) || document.hidden) return;
      const a = highlight?.getBoundingClientRect(),
        b = scroll.getBoundingClientRect();
      const visible =
        !!a &&
        a.width > 0 &&
        a.height > 0 &&
        a.right > b.left &&
        a.left < b.right &&
        a.bottom > b.top &&
        a.top < b.bottom;
      if (highlight)
        location.textContent = visible
          ? `PDF 原页 ${number} · 来源区域已显示`
          : `PDF 原页 ${number} · 来源区域未进入视口，请手动核对`;
      else if (!this.target) location.textContent = `PDF 原页 ${number} 已显示`;
      emitMetric("original_visible", {
        book_id: this.book,
        page_number: number,
        render_token: token,
        elapsed_ms: performance.now() - started,
        source_highlighted: visible,
        dpr,
      });
    } catch (error) {
      if (
        !this.valid(token) ||
        ["AbortError", "RenderingCancelledException"].includes(error.name)
      )
        return;
      message.textContent = error.message || "原件暂不能显示。";
      message.hidden = false;
      sheet.hidden = true;
      location.textContent = "原版尚未显示";
      emitMetric("original_failed", {
        book_id: this.book,
        page_number: number,
        render_token: token,
        error: message.textContent,
      });
    } finally {
      page?.cleanup();
    }
  }
  highlight(page, base, viewport, sheet) {
    const source = this.target;
    if (!source || source.page_number !== this.pageNumber) return null;
    if (!source.bbox) {
      $("[data-pdf-location]", this.dialog).textContent =
        `PDF 原页 ${this.pageNumber} 已显示`;
      return null;
    }
    const bbox = source.bbox;
    const valid =
      source.coordinate_space === "rotated_crop_top_left" &&
      Number.isFinite(source.width) &&
      Number.isFinite(source.height) &&
      Math.abs(source.width - base.width) <= 0.75 &&
      Math.abs(source.height - base.height) <= 0.75 &&
      (source.rotation == null || source.rotation === page.rotate) &&
      (!source.crop_box ||
        (Array.isArray(source.crop_box) &&
          source.crop_box.length === 4 &&
          source.crop_box.every(
            (v, i) => Number.isFinite(v) && Math.abs(v - page.view[i]) <= 0.75,
          ))) &&
      Array.isArray(bbox) &&
      bbox.length === 4 &&
      bbox.every(Number.isFinite) &&
      bbox[0] >= -0.75 &&
      bbox[1] >= -0.75 &&
      bbox[2] <= base.width + 0.75 &&
      bbox[3] <= base.height + 0.75 &&
      bbox[2] > bbox[0] &&
      bbox[3] > bbox[1];
    if (!valid) {
      $("[data-pdf-location]", this.dialog).textContent =
        `PDF 原页 ${source.page_number} · 来源区域暂无法可靠定位`;
      emitMetric("source_geometry_unverified", {
        book_id: this.book,
        page_number: source.page_number,
      });
      return null;
    }
    const width = base.width,
      height = base.height;
    const point = (x, y) =>
      this.rotation === 90
        ? [height - y, x]
        : this.rotation === 180
          ? [width - x, height - y]
          : this.rotation === 270
            ? [y, width - x]
            : [x, y];
    const a = point(bbox[0], bbox[1]),
      b = point(bbox[2], bbox[3]);
    const scale = viewport.width / (this.rotation % 180 ? height : width);
    const highlight = document.createElement("div");
    highlight.className = "pdf-source-highlight";
    Object.assign(highlight.style, {
      left: `${Math.min(a[0], b[0]) * scale}px`,
      top: `${Math.min(a[1], b[1]) * scale}px`,
      width: `${Math.abs(a[0] - b[0]) * scale}px`,
      height: `${Math.abs(a[1] - b[1]) * scale}px`,
    });
    sheet.append(highlight);
    return highlight;
  }
  dispose(returnToReader = false) {
    if (this.closed) return;
    this.closed = true;
    this.renderToken += 1;
    this.renderTask?.cancel();
    this.renderTask?.promise.catch(() => {});
    this.loading?.destroy().catch(() => {});
    this.scope.dispose();
    if (this.dialog?.open) this.dialog.close();
    this.dialog?.remove();
    if (returnToReader && !this.owner.signal.aborted)
      Promise.resolve(this.onReturn?.()).catch((error) => toast(error.message));
  }
}

function safeToUpdate(r, controller, ignoreRestoring = false) {
  const root = $(".reader");
  return (
    !r.scope.signal.aborted &&
    !document.hidden &&
    !controller.viewer &&
    (ignoreRestoring || !r.restoring) &&
    !r.selection &&
    !r.popElement &&
    !r.panelId &&
    !r.notesController?.editor &&
    !r.pending?.size &&
    !r.pages?.animating &&
    !r.pages?.preview &&
    !r.pages?.displayPending &&
    root?.dataset.pageTurning !== "true" &&
    !document.querySelector("dialog[open]") &&
    !getSelection()?.toString().trim() &&
    !document.activeElement?.closest(
      "input,textarea,select,[contenteditable='true']",
    ) &&
    !controller.pointerDown
  );
}
class PDFReading {
  constructor(r) {
    this.r = r;
    this.scope = r.scope;
    this.book = r.doc.pdf.book_id;
    this.status = { pdf: r.doc.pdf, task: r.doc.pdf.task };
    this.seenRevision = r.doc.pdf.revision;
    this.busy = false;
    this.viewer = null;
    this.pointerDown = false;
  }
  install() {
    const r = this.r;
    r.pdfTools = this;
    r.pdfCanRefresh = () => safeToUpdate(r, this, true);
    r.tool("pdf", "PDF 处理", () => this.details());
    r.selectionAction("pdf-source", "核对原版", () =>
      this.openOriginal(sourceOf(r, r.selection), r.selection),
    );
    const jumpKey = `jump:${r.doc.id}`,
      jump = local.get(jumpKey);
    if (jump?.kind === "image" && !jump.resume_position && !imageMatchesDoc(r, jump)) {
      local.remove(jumpKey);
      const savedSource = structuredClone(jump.pdf_source);
      const ready = () => {
        if (this.scope.signal.aborted) return;
        if (!r.restoring && $(".reader")?.dataset.ready === "true") {
          this.openOriginal(savedSource);
          toast("旧原图引用已保留，当前对象无法可靠对应，已打开来源原页。");
        } else this.jumpTimer = setTimeout(ready, 100);
      };
      this.jumpTimer = setTimeout(ready, 100);
      this.scope.cleanup(() => clearTimeout(this.jumpTimer));
    }
    this.scope.on($("#article"), "click", (event) => {
      const figure = event.target.closest("[data-pdf-object]");
      if (
        !figure ||
        event.target.closest("button,a") ||
        getSelection()?.toString().trim()
      )
        return;
      const block = r.doc.blocks.find((b) => b.id === figure.dataset.pdfObject);
      if (!objectBlock(block)) return;
      event.preventDefault();
      event.stopPropagation();
      this.objectActions(block, figure.getBoundingClientRect());
    });
    this.scope.on(
      document,
      "pointerdown",
      () => {
        this.pointerDown = true;
      },
      { capture: true },
    );
    this.scope.on(
      document,
      "pointerup",
      () => {
        this.pointerDown = false;
      },
      { capture: true },
    );
    this.scope.on(
      document,
      "pointercancel",
      () => {
        this.pointerDown = false;
      },
      { capture: true },
    );
    this.scope.on(window, "blur", () => {
      this.pointerDown = false;
    });
    this.scope.cleanup(() => {
      clearTimeout(this.timer);
      this.viewer?.dispose();
      if (r.pdfTools === this) delete r.pdfTools;
      delete r.pdfCanRefresh;
    });
    this.schedule();
  }
  outline() {
    if (!this.outlineController) {
      // Read the original's bookmark tree only when the reader asks for it.
      // The existing range loader stays scoped to this Reader, like source view.
      const parser = new OriginalViewer(
        this.scope, this.book, this.r.doc.pdf.source_url, this.r.doc.title,
      );
      this.outlineController = new PDFOutline(this, () => parser.load());
    }
    return this.outlineController.open();
  }
  schedule(ms = 1800) {
    clearTimeout(this.timer);
    if (!this.scope.signal.aborted)
      this.timer = setTimeout(() => this.poll(), ms);
  }
  async poll() {
    if (this.scope.signal.aborted || this.busy) return;
    this.busy = true;
    try {
      const status = await pdfApi(pathFor(this.book), {
        signal: this.scope.signal,
      });
      if (this.scope.signal.aborted) return;
      this.status = status;
      const pdf = status.pdf || {};
      if (this.r.panelId === "pdf") this.drawTask();
      if (
        pdf.revision != null &&
        pdf.revision !== this.seenRevision &&
        safeToUpdate(this.r, this)
      ) {
        // A neighboring range may publish while the current canonical version
        // stays the same. Reader refresh handles that as a metadata-only update.
        const requested = {
          docId: this.r.doc.id,
          density: this.r.doc.density,
          generation: this.r.generation,
        };
        const next = await fetch(
          `/api/documents/${requested.docId}?compact=true&density=${requested.density}`,
          {
            signal: this.scope.signal,
            credentials: "same-origin",
            cache: "no-store",
          },
        );
        if (!next.ok) throw new Error("当前阅读范围暂不能刷新。");
        const doc = await next.json();
        if (
          this.scope.signal.aborted ||
          requested.docId !== this.r.doc.id ||
          requested.density !== this.r.doc.density ||
          requested.generation !== this.r.generation ||
          !safeToUpdate(this.r, this)
        )
          return;
        const previousVersion = this.r.doc.version;
        const applied = await this.r.refresh(this.r.doc.density, {
          pdfBackground: true,
          nextDocument: doc,
        });
        if (this.scope.signal.aborted || applied !== true) return;
        if (doc.version !== this.r.doc.version) return;
        this.seenRevision = pdf.revision;
        if (previousVersion !== this.r.doc.version)
          emitMetric("reading_revision_applied", {
            book_id: this.book,
            doc_id: this.r.doc.id,
            revision: this.r.doc.pdf?.revision,
            version: this.r.doc.version,
          });
      }
    } catch (error) {
      if (error.name !== "AbortError") this.pollError = error.message;
    } finally {
      this.busy = false;
      this.schedule(
        ["queued", "running", "converting"].includes(this.status?.task?.state)
          ? 1800
          : 5000,
      );
    }
  }
  openOriginal(source, anchor) {
    if (this.scope.signal.aborted) return;
    if (
      source?.book_id != null &&
      String(source.book_id) !== String(this.book)
    ) {
      toast("这份引用不属于当前书籍，来源未打开。");
      return;
    }
    if (
      source?.source_sha256 &&
      source.source_sha256 !== this.r.doc.pdf.source_sha256
    ) {
      toast("原件身份不匹配，来源未打开。");
      return;
    }
    this.viewer?.dispose();
    const position = structuredClone(anchor || this.r.position());
    const selection = this.r.selection
      ? structuredClone(this.r.selection)
      : null;
    this.r.closePanel();
    this.r.closePop();
    this.r.focus.close();
    const viewer = (this.viewer = new OriginalViewer(
      this.scope,
      this.book,
      this.r.doc.pdf.source_url,
      this.r.doc.title,
      async () => {
        try {
          if (this.scope.signal.aborted) return;
          await this.r.restore(position, { automatic: true, mark: false });
          if (!this.scope.signal.aborted && selection) this.r.choose(selection);
        } finally {
          if (this.viewer === viewer) this.viewer = null;
        }
      },
    ));
    viewer.open(source, source?.page_number || this.r.doc.pdf.start_page || 1);
  }
  objectActions(block, rect) {
    const r = this.r;
    r.closePop();
    r.panel(
      "pdf-object",
      "原图",
      `<p class="meta">PDF 原页 ${e(block.source?.page_number || "—")}</p><div class="pdf-object-actions">${actionButton("source", "核对原版", !block.source)}${r.ctx.enabled("notes") ? actionButton("note", "记一笔") : ""}${r.ctx.enabled("bookmarks") ? actionButton("bookmark", "书签") : ""}</div>`,
      (el, scope) => {
        const panel = $("#tool-panel");
        panel.classList.add("pdf-object-menu");
        const place = () => {
          const box = panel.getBoundingClientRect();
          panel.style.left = `${Math.max(12, Math.min(rect?.left || 12, innerWidth - box.width - 12))}px`;
          panel.style.top = `${Math.max(12, Math.min((rect?.bottom || 40) + 8, innerHeight - box.height - 12))}px`;
        };
        place();
        scope.on(window, "resize", place);
        scope.cleanup(() => {
          panel.classList.remove("pdf-object-menu");
          panel.style.left = "";
          panel.style.top = "";
        });
        scope.on(el, "click", async (event) => {
          const button = event.target.closest("[data-pdf-action]");
          if (!button || button.disabled) return;
          if (button.dataset.pdfAction === "source")
            this.openOriginal(block.source, imageAnchor(r, block));
          if (button.dataset.pdfAction === "note") {
            r.closePanel();
            r.notesController?.addImage(block);
          }
          if (button.dataset.pdfAction === "bookmark") {
            button.disabled = true;
            try {
              const anchor = imageAnchor(r, block);
              if (!anchor) throw new Error("原图来源暂不可用。");
              const result = await fetch("/api/bookmarks/toggle", {
                method: "POST",
                signal: this.scope.signal,
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  doc_id: r.doc.id,
                  label: `原图 · PDF 原页 ${block.source.page_number}`,
                  scroll_ratio: anchor.ratio,
                  anchor,
                }),
              });
              if (!result.ok) throw new Error("原图书签暂未保存。");
              const data = await result.json();
              if (this.scope.signal.aborted) return;
              r.bookmarks = data.bookmarks;
              await r.ctx.run("draw", r);
              r.updateBookmark?.();
              r.pages.invalidatePaint();
              button.textContent = data.active ? "已加书签" : "书签";
              toast(data.active ? "已为原图添加书签" : "已移除原图书签");
            } catch (error) {
              if (error.name !== "AbortError") toast(error.message);
            } finally {
              if (!scope.signal.aborted) button.disabled = false;
            }
          }
        });
      },
    );
  }
  async details() {
    const r = this.r;
    await r.panel(
      "pdf",
      "PDF 处理",
      '<div class="pdf-task-summary" role="status">正在读取…</div><div class="pdf-processing-controls"></div>',
      async (el, scope) => {
        const [statusResult, capsResult] = await Promise.allSettled([
          pdfApi(pathFor(this.book), { signal: scope.signal }),
          pdfApi("/pdf/capabilities", { signal: scope.signal }),
        ]);
        if (scope.signal.aborted || this.scope.signal.aborted) return;
        if (statusResult.status === "rejected") throw statusResult.reason;
        const status = statusResult.value,
          caps = capsResult.status === "fulfilled" ? capsResult.value : null,
          capabilityError = caps ? "" : "处理能力读取失败，请重新打开此面板。";
        this.status = status;
        this.caps = caps;
        this.drawTask();
        const pdf = status.pdf || this.r.doc.pdf;
        const actions = Array.isArray(caps?.supported_actions)
          ? caps.supported_actions
          : [];
        const controls = $(".pdf-processing-controls", el);
        controls.innerHTML = `${processingPicker(caps, capabilityError)}<div class="row wrap">${actionButton("source", "核对 PDF 原版")}${actions
          .filter((a) => ["pause", "resume", "cancel", "convert"].includes(a))
          .map((a) =>
            actionButton(
              a,
              {
                pause: "暂停转换",
                resume: "继续转换",
                cancel: "取消这次转换",
                convert: "继续准备阅读版",
              }[a],
              !pdf.processing_enabled,
            ),
          )
          .join(
            "",
          )}</div>${actions.includes("convert") ? `<p class="meta">准备阅读版处理原页 1 至 ${e(pdf.page_count)}，已有内容保留。</p>` : ""}${actions.includes("recognize") ? `<section class="pdf-recognize"><h3>重新识别原页</h3><p class="muted">只处理这里选定的原页，保留已有可读内容。</p>${processingPicker(caps, capabilityError, true)}<div class="row"><label>从 <input type="number" min="1" max="${pdf.page_count}" value="${pdf.start_page || 1}" data-pdf-start></label><label>到 <input type="number" min="1" max="${pdf.page_count}" value="${pdf.start_page || 1}" data-pdf-end></label></div>${actionButton("recognize", "识别选定原页", true)}</section>` : ""}${pdf.processing_enabled ? "" : '<p class="meta">PDF 处理已关闭；原件、阅读版与记录仍保留。</p>'}<div class="row wrap">${actionButton("recycle", "从书架回收")}</div><p class="pdf-operation-state meta" role="status"></p>`;
        const sourcePage =
          sourceOf(r, r.selection || r.position())?.page_number ||
          pdf.start_page ||
          1;
        for (const input of $$("[data-pdf-start],[data-pdf-end]", controls))
          input.value = sourcePage;
        this.drawTask();
        for (const select of $$("[data-pdf-engine],[data-pdf-range-engine]", controls))
          scope.on(select, "change", () => this.drawTask());
        scope.on(controls, "click", async (event) => {
          const button = event.target.closest("[data-pdf-action]");
          if (
            !button || button.disabled ||
            controls.dataset.pdfOperationPending === "true"
          ) return;
          const action = button.dataset.pdfAction;
          if (action === "source") {
            this.openOriginal(sourceOf(r, r.selection || r.position()));
            return;
          }
          controls.dataset.pdfOperationPending = "true";
          this.drawTask();
          const message = $(".pdf-operation-state", controls);
          try {
            let body = { action };
            const engine = $(action === "recognize" ? "[data-pdf-range-engine]" : "[data-pdf-engine]", controls)?.value,
              choice = processingChoices(caps).find((item) => item.id === engine);
            if (["recognize", "convert"].includes(action) && !choice?.available)
              throw new Error(choice?.missing_reason || "请选择可用的处理位置。");
            if (action === "recognize") {
              if (!supportsPageRanges(choice))
                throw new Error("此引擎仅支持整书处理，请使用整书入口。");
              const start = Number($("[data-pdf-start]", controls).value),
                end = Number($("[data-pdf-end]", controls).value);
              if (
                !Number.isInteger(start) ||
                !Number.isInteger(end) ||
                start < 1 ||
                end < start ||
                end > pdf.page_count
              )
                throw new Error("请选择有效的原页范围。");
              body = { action, engine, start_page: start, end_page: end };
            }
            if (action === "convert") {
              const currentPdf = this.status?.pdf || pdf,
                currentTask = this.status?.task || currentPdf.task || {};
              body = wholeBookRequest(currentTask, currentPdf, engine, caps);
            }
            message.textContent = "正在提交…";
            const next = await pdfApi(
              pathFor(
                this.book,
                action === "recycle" ? "/lifecycle" : "/operations",
              ),
              { method: "POST", body, signal: scope.signal },
            );
            if (scope.signal.aborted || this.scope.signal.aborted) return;
            this.status = next;
            this.drawTask();
            message.textContent =
              action === "recycle"
                ? "已回收，原件与记录保留。"
                : "已提交，已有阅读内容保留。";
            if (action === "recycle") {
              r.closePanel();
              toast("书籍已回收", {
                label: "恢复",
                run: async () => {
                  await pdfApi(pathFor(this.book, "/lifecycle"), {
                    method: "POST",
                    body: { action: "restore" },
                  });
                  r.ctx.refresh();
                },
              });
              r.ctx.navigate(`#/pdf/${this.book}`);
            }
          } catch (error) {
            if (error.name !== "AbortError" && !scope.signal.aborted)
              message.textContent = error.message;
          } finally {
            delete controls.dataset.pdfOperationPending;
            if (!scope.signal.aborted) {
              this.drawTask();
            }
          }
        });
      },
    );
  }
  drawTask() {
    if (this.scope.signal.aborted || this.r.panelId !== "pdf") return;
    const element = $(".pdf-task-summary", $("#tool-panel"));
    if (!element) return;
    const pdf = this.status?.pdf || this.r.doc.pdf,
      task = this.status?.task || pdf.task || {};
    element.innerHTML = `<dl class="pdf-task-grid"><dt>处理状态</dt><dd>${e(statusLabel(task.state))}</dd><dt>已处理原页</dt><dd>${e(task.done_pages ?? 0)} / ${e(task.total_pages ?? pdf.page_count ?? "—")}</dd><dt>当前阅读范围</dt><dd>PDF 原页 ${e(this.r.doc.pdf.start_page)}–${e(this.r.doc.pdf.end_page)}</dd>${taskProcessing(task, this.caps)}${task.error ? `<dt>原因</dt><dd>${e(typeof task.error === "string" ? task.error : task.error.message || task.error.code)}</dd>` : ""}</dl>`;
    updateProcessingControls(
      $(".pdf-processing-controls", $("#tool-panel")),
      pdf,
      task,
      this.caps,
    );
  }
}

function preparationControls(ctx, owner, id, refresh) {
  const scope = new Scope();
  let content, dialog;
  const valid = () =>
    !owner.signal.aborted &&
    !scope.signal.aborted &&
    content &&
    dialog?.contains(content);
  owner.cleanup(() => {
    scope.dispose();
    if (content && dialog?.contains(content) && dialog.open) dialog.close();
  });
  dialog = ctx.openDialog(
    "PDF 处理",
    '<div class="pdf-preparation-task"><p class="muted">正在读取处理状态…</p></div>',
    (element) => {
      content = $(".pdf-preparation-task", element);
      scope.on(element, "close", () => scope.dispose());
    },
  );
  (async () => {
    try {
      const [dataResult, capsResult] = await Promise.allSettled([
        pdfApi(pathFor(id), { signal: scope.signal }),
        pdfApi("/pdf/capabilities", { signal: scope.signal }),
      ]);
      if (!valid()) return;
      if (dataResult.status === "rejected") throw dataResult.reason;
      const data = dataResult.value,
        caps = capsResult.status === "fulfilled" ? capsResult.value : null,
        capabilityError = caps ? "" : "处理能力读取失败，请重新打开此面板。";
      const pdf = data.pdf || {},
        task = data.task || pdf.task || {};
      const actions = Array.isArray(caps?.supported_actions)
        ? caps.supported_actions
        : [];
      content.innerHTML = `<dl class="pdf-task-grid"><dt>状态</dt><dd>${e(statusLabel(task.state))}</dd><dt>实际进度</dt><dd>${e(task.done_pages ?? 0)} / ${e(task.total_pages ?? pdf.page_count)} 原页</dd>${taskProcessing(task, caps)}${task.error ? `<dt>原因</dt><dd>${e(typeof task.error === "string" ? task.error : task.error.message || task.error.code)}</dd>` : ""}</dl><div class="pdf-processing-controls">${processingPicker(caps, capabilityError)}<div class="row wrap">${actions
        .filter((a) => ["convert", "pause", "resume", "cancel"].includes(a))
        .map((action) =>
          actionButton(
            action,
            {
              convert:
                task.state === "cancelled" ? "开始新的转换" : "准备阅读版",
              pause: "暂停转换",
              resume: "继续转换",
              cancel: "取消这次转换",
            }[action],
            true,
          ),
        )
        .join(
          "",
        )}</div><p class="meta">${pdf.processing_enabled ? "准备阅读版使用上面选择的处理位置，处理原页 1 至 " + e(pdf.page_count) + "，已有内容保留。" : "PDF 处理已关闭。原件、已生成内容和阅读记录保留。"}</p><p class="pdf-operation-state meta" role="status"></p></div>`;
      const controls = $(".pdf-processing-controls", content),
        update = () => updateProcessingControls(controls, pdf, task, caps);
      update();
      scope.on($("[data-pdf-engine]", controls), "change", update);
      scope.on(content, "click", async (event) => {
        const button = event.target.closest("[data-pdf-action]");
        if (
          !button || button.disabled ||
          controls.dataset.pdfOperationPending === "true"
        ) return;
        controls.dataset.pdfOperationPending = "true";
        update();
        const action = button.dataset.pdfAction,
          state = $(".pdf-operation-state", content);
        try {
          const engine = $("[data-pdf-engine]", controls).value,
            choice = processingChoices(caps).find((item) => item.id === engine);
          if (action === "convert" && !choice?.available)
            throw new Error(choice?.missing_reason || "请选择可用的处理位置。");
          state.textContent = "正在提交…";
          const body =
            action === "convert"
              ? wholeBookRequest(task, pdf, engine, caps)
              : { action };
          await pdfApi(pathFor(id, "/operations"), {
            method: "POST",
            body,
            signal: scope.signal,
          });
          if (!valid()) return;
          dialog.close();
          if (!owner.signal.aborted) await refresh();
        } catch (error) {
          if (valid() && error.name !== "AbortError")
            state.textContent = `${error.message} 请刷新状态核对已提交的任务。`;
        } finally {
          delete controls.dataset.pdfOperationPending;
          if (valid()) update();
        }
      });
    } catch (error) {
      if (valid() && error.name !== "AbortError")
        content.innerHTML = `<p class="notice error">${e(error.message)}</p>`;
    }
  })();
}
async function preparation(ctx, scope, id, { autoRead = true } = {}) {
  if (!/^\d+$/.test(id || "")) throw new Error("PDF 书籍身份无效。");
  ctx.root.innerHTML =
    '<div class="page pdf-preparation"><div class="loading" role="status">正在打开书籍…</div></div>';
  let viewer = null,
    timer,
    busy = false,
    last = null;
  scope.cleanup(() => {
    clearTimeout(timer);
    viewer?.dispose();
  });
  const refresh = async () => {
    if (scope.signal.aborted || busy) return;
    busy = true;
    try {
      const data = await pdfApi(pathFor(id), { signal: scope.signal });
      if (scope.signal.aborted) return;
      last = data;
      const pdf = data.pdf || {},
        task = data.task || pdf.task || {},
        chapters = data.chapters || [];
      const ready = chapters.find(
        (chapter) => chapter.doc_id === pdf.reading_doc_id,
      );
      const recycled = pdf.lifecycle === "recycled";
      ctx.root.innerHTML = `<div class="page pdf-preparation"><div class="page-head"><div><div class="eyebrow">PDF</div><h1>${e(data.title)}</h1><p>${e(recycled ? "书籍已回收" : statusLabel(task.state))}</p></div><a class="button" href="#/">← 书架</a></div><section class="card"><p role="status">${recycled ? "书籍已从书架回收，原件、阅读版和记录保留。恢复后已有内容仍可读，未完成转换保持暂停。" : ready ? "阅读版支持重排；未可靠整理的部分会保留原图，可按需核对 PDF 原版。" : "书籍已保存，阅读版正在准备。可以先核对原版，稍后从书架继续。"}</p>${task.error ? `<p class="muted">${e(typeof task.error === "string" ? task.error : task.error.message || task.error.code)}</p>` : ""}<div class="row wrap">${recycled ? '<button type="button" data-restore-pdf class="primary">恢复书籍</button>' : ready ? `<a class="button primary" href="#/read/${ready.doc_id}">打开阅读版 →</a>` : ""}<button type="button" data-open-original>核对 PDF 原版</button><button type="button" data-pdf-preparation-controls>PDF 处理</button><button type="button" data-refresh-pdf class="text-button">刷新状态</button></div>${pdfImportProgress(data)}</section></div>`;
      $("[data-open-original]", ctx.root).onclick = () => {
        viewer?.dispose();
        viewer = new OriginalViewer(
          scope,
          id,
          last.pdf.source_url,
          last.title,
          () => {
            viewer = null;
          },
        );
        viewer.open(null, 1);
      };
      $("[data-refresh-pdf]", ctx.root).onclick = refresh;
      const restore = $("[data-restore-pdf]", ctx.root);
      if (restore)
        restore.onclick = async () => {
          restore.disabled = true;
          try {
            await pdfApi(pathFor(id, "/lifecycle"), {
              method: "POST",
              body: { action: "restore" },
              signal: scope.signal,
            });
            if (!scope.signal.aborted) await refresh();
          } catch (error) {
            if (!scope.signal.aborted && error.name !== "AbortError")
              toast(error.message);
          } finally {
            if (!scope.signal.aborted) restore.disabled = false;
          }
        };
      $("[data-pdf-preparation-controls]", ctx.root).onclick = () =>
        preparationControls(ctx, scope, id, refresh);
      // Enter the normal Reader only after an actual published range exists.
      // Keep an explicitly opened original view stable until the reader closes it.
      if (
        autoRead &&
        !recycled &&
        ready &&
        !viewer &&
        !document.querySelector("dialog[open]")
      )
        ctx.navigate(`#/read/${ready.doc_id}`);
    } catch (error) {
      if (scope.signal.aborted || error.name === "AbortError") return;
      ctx.root.innerHTML = `<div class="page"><h1>PDF 暂不能打开</h1><p class="notice error">${e(error.message)}</p><a class="button" href="#/">返回书架</a><button data-refresh-pdf>重试</button></div>`;
      $("[data-refresh-pdf]", ctx.root).onclick = refresh;
    } finally {
      busy = false;
      if (!scope.signal.aborted) timer = setTimeout(refresh, 2000);
    }
  };
  await refresh();
}
async function recycledBooks(ctx, scope) {
  ctx.root.innerHTML =
    '<div class="page pdf-recycled-books"><div class="page-head"><div><div class="eyebrow">PDF</div><h1>回收的书籍</h1><p>原件、已有阅读内容和记录仍保留。恢复不会重新处理。</p></div><a class="button" href="#/">← 书架</a></div><div class="row"><button type="button" data-pdf-recycle-refresh class="text-button">刷新清单</button></div><section class="card" data-pdf-recycled-list aria-live="polite"><p class="muted">正在读取回收清单…</p></section></div>';
  const list = $("[data-pdf-recycled-list]", ctx.root),
    refreshButton = $("[data-pdf-recycle-refresh]", ctx.root);
  let books = [],
    busy = false;
  const pending = new Set();
  const load = async () => {
    if (scope.signal.aborted || busy || pending.size) return;
    busy = true;
    refreshButton.disabled = true;
    for (const button of $$("[data-pdf-restore-book]", list))
      button.disabled = true;
    try {
      const data = await pdfApi("/pdf/recycle", { signal: scope.signal });
      if (scope.signal.aborted) return;
      if (!Array.isArray(data.books))
        throw new Error("回收清单没有返回有效书籍列表。");
      books = data.books;
      list.innerHTML =
        books
          .map((book) => {
            const id = book.book_id ?? book.pdf?.book_id,
              task = book.task || book.pdf?.task || {};
            if (id == null) return "";
            return `<article class="list-item" data-pdf-recycled-book="${e(id)}"><div class="row between"><div><h3>${e(book.title || "PDF 书籍")}</h3><p class="meta">${e(book.pdf?.page_count || "—")} 原页 · ${e(statusLabel(task.state))}</p></div><button type="button" data-pdf-restore-book="${e(id)}">恢复书籍</button></div><p class="meta" data-pdf-restore-state role="status"></p></article>`;
          })
          .join("") ||
        '<div class="empty"><p>没有已回收的 PDF。</p><a class="text-button" href="#/">返回书架 →</a></div>';
    } catch (error) {
      if (!scope.signal.aborted && error.name !== "AbortError")
        list.innerHTML = `<p class="notice error">${e(error.message)}</p><p class="muted">清单尚未读取，不能据此判断没有已回收书籍。</p>`;
    } finally {
      busy = false;
      if (!scope.signal.aborted) refreshButton.disabled = false;
    }
  };
  scope.on(refreshButton, "click", load);
  scope.on(list, "click", async (event) => {
    const button = event.target.closest("[data-pdf-restore-book]");
    if (!button || button.disabled || busy) return;
    const id = button.dataset.pdfRestoreBook;
    if (pending.has(id)) return;
    const book = books.find(
      (item) => String(item.book_id ?? item.pdf?.book_id) === id,
    );
    if (!book) return;
    const row = button.closest("[data-pdf-recycled-book]"),
      state = $("[data-pdf-restore-state]", row);
    pending.add(id);
    button.disabled = true;
    button.textContent = "恢复中…";
    refreshButton.disabled = true;
    state.textContent = "正在恢复保留的原件与记录…";
    try {
      const restored = await pdfApi(pathFor(id, "/lifecycle"), {
        method: "POST",
        body: { action: "restore" },
        signal: scope.signal,
      });
      if (scope.signal.aborted || !list.contains(row)) return;
      if (restored.pdf?.lifecycle === "recycled")
        throw new Error("书籍仍处于回收状态，请刷新清单核对。");
      const task = restored.task || restored.pdf?.task;
      button.textContent = "已恢复";
      state.textContent = `已恢复，已有内容和记录保留。${task?.state ? `转换状态：${statusLabel(task.state)}。` : ""}`;
      const back = document.createElement("a");
      back.className = "text-button";
      back.href = "#/";
      back.textContent = "回到书架 →";
      row.append(back);
      emitMetric("book_restored", {
        book_id: restored.book_id ?? id,
        task_state: task?.state || null,
      });
    } catch (error) {
      if (
        !scope.signal.aborted &&
        list.contains(row) &&
        error.name !== "AbortError"
      ) {
        button.disabled = false;
        button.textContent = "恢复书籍";
        state.textContent = `${error.message} 请刷新清单核对实际状态。`;
      }
    } finally {
      pending.delete(id);
      if (!scope.signal.aborted) refreshButton.disabled = pending.size > 0;
    }
  });
  await load();
}
export function install(ctx) {
  const read = ctx.hook("read", (r) => {
    if (r.doc.pdf) new PDFReading(r).install();
  });
  const route = ctx.route("pdf", (scope, id) => preparation(ctx, scope, id));
  const statusRoute = ctx.route("pdf-status", (scope, id) =>
    preparation(ctx, scope, id, { autoRead: false }),
  );
  const recycleRoute = ctx.route("pdf-recycle", (scope) =>
    recycledBooks(ctx, scope),
  );
  return () => {
    read();
    route();
    statusRoute();
    recycleRoute();
  };
}
