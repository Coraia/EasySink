import { api, e } from "../core.js";

const streams = new Map();
const workingStates = new Set(["queued", "running"]);

function processingLocation(task) {
  if (task.engine === "omarchy")
    return "处理位置：你的 Omarchy · GPU OCR，无付费 API";
  if (task.engine === "mineru_source")
    return "处理位置：当前电脑 · 原式优先，公式按需识别";
  if (["auto", "digital", "docling"].includes(task.engine))
    return "处理位置：当前电脑";
  return task.engine
    ? `处理引擎：${task.engine}（位置未确认）`
    : "处理位置待确认";
}

export function pdfFailedPageNotice(task) {
  const failed = task?.metrics?.conversion_metrics?.failed_pages;
  return Number.isSafeInteger(failed) && failed > 0
    ? `本次处理有 ${failed} 页以原图保留，可核对原版。`
    : "";
}

export function pdfFallbackPageNotice(task) {
  const metrics = task?.metrics?.conversion_metrics || {};
  const fallback = metrics.fallback_pages;
  const whole = metrics.whole_image_pages;
  if (Number.isSafeInteger(whole) && whole > 0) {
    const local = Number.isSafeInteger(fallback) ? Math.max(0, fallback - whole) : 0;
    return `本次处理有 ${whole} 页仍为整页原图，暂不可选字${local ? `；另有 ${local} 页包含局部原图` : ""}。`;
  }
  return Number.isSafeInteger(fallback) && fallback > 0
    ? `本次处理有 ${fallback} 页仍含原图保留内容；图片部分暂不可选字。`
    : "";
}

export function pdfImportProgress(book, { stale = false } = {}) {
  const pdf = book.pdf || {};
  const task = pdf.task || book.task || {};
  const total = Number(pdf.page_count) || 0;
  const ready = Math.max(0, Math.min(Number(pdf.ready_pages) || 0, total || Infinity));
  const complete = total > 0 && ready >= total;
  const working = workingStates.has(task.state);
  const taskProgress = ["queued", "running", "paused", "failed", "partial", "cancelled", "interrupted"].includes(task.state);
  const taskTotal = Number.isSafeInteger(task.total_pages) && task.total_pages > 0 ? task.total_pages : 0;
  const taskDone = Math.max(0, Math.min(Number(task.done_pages) || 0, taskTotal || Infinity));
  const hasFallback = Number(task?.metrics?.conversion_metrics?.fallback_pages) > 0;
  const wholeImagePages = task?.metrics?.conversion_metrics?.whole_image_pages;
  const hasWholeImage = Number(wholeImagePages) > 0;
  const fallbackLabel = Number.isSafeInteger(wholeImagePages) ? "含局部原图" : "含原图";
  let label = complete ? (hasWholeImage ? "整理完成 · 部分页面仍为原图" : hasFallback ? `阅读内容已准备 · ${fallbackLabel}` : "阅读版已准备") : "正在准备阅读版";
  let detail = ready ? "已有内容可先读，其余页面继续准备。" : "原件已保存，可以关闭弹窗，稍后从书架继续。";
  let state = working ? "working" : "waiting";
  if (pdf.bridge_error || task.state === "failed" || task.state === "partial") {
    label = "准备中断";
    detail = "原件和已有内容保留，可在处理详情中继续。";
    state = "attention";
  } else if (task.state === "paused" || pdf.processing_enabled === false) {
    label = pdf.processing_enabled === false ? "准备已关闭" : "准备已暂停";
    detail = "已有内容保留，可在处理详情中继续。";
  } else if (task.state === "cancelled") {
    label = "准备已取消";
    detail = "原件和已有内容保留。";
  } else if (task.state === "preparing") {
    label = "阅读版待准备";
    detail = "原件已保存，可在处理详情中开始。";
    if (task.error) state = "attention";
  } else if (task.state === "queued") {
    label = "等待处理";
  } else if (working) {
    label = ready ? "正在更新阅读版" : "正在准备阅读版";
    detail = "正在处理本轮原页，已有内容仍可阅读。";
    if (!ready) detail = "正在处理原页并整理可读内容。";
  } else if (complete) {
    state = "complete";
    detail = "";
  } else if (task.state === "completed") {
    label = ready ? "部分内容已就绪" : "阅读版尚未就绪";
    detail = "本次处理已结束，可读范围以当前进度为准。";
  }
  if (!ready && working && Number(task.done_pages) > 0)
    detail = `已处理 ${Number(task.done_pages)} 原页，正在整理可读内容。`;
  if (stale) { state = "stale"; detail = "连接暂时中断，显示上次进度；正在重新连接。"; }
  const count = taskProgress
    ? taskTotal ? `本轮已处理 ${taskDone} / ${taskTotal} 原页` : `本轮已处理 ${taskDone} 原页，范围待确认`
    : total ? `${ready} / ${total} 原页已整理` : "正在确认页数";
  const progressTotal = taskProgress ? taskTotal : total;
  const progressDone = taskProgress ? taskDone : ready;
  const retained = taskProgress && ready
    ? `已有阅读内容：${ready}${total ? ` / ${total}` : ""} 原页，仍可阅读。` : "";
  const failure = pdf.bridge_error || task.error;
  const reason = typeof failure === "string" ? failure : failure?.message || failure?.code;
  const failedPageNotice = pdfFailedPageNotice(task);
  const fallbackPageNotice = pdfFallbackPageNotice(task);
  return `<div class="pdf-import-progress" data-state="${state}"><div class="pdf-import-progress-heading"><span>${e(label)}</span><span class="pdf-import-progress-count">${e(count)}</span></div><progress aria-label="${taskProgress ? "本轮 PDF 处理进度" : "阅读版准备进度"}" ${progressTotal ? `max="${progressTotal}" value="${progressDone}" aria-valuetext="${e(count)}"` : ""}></progress><div class="pdf-import-progress-detail">${e(processingLocation(task))}</div>${retained ? `<div class="pdf-import-progress-detail">${e(retained)}</div>` : ""}${detail ? `<div class="pdf-import-progress-detail">${e(detail)}</div>` : ""}${fallbackPageNotice ? `<div class="pdf-import-progress-detail">${e(fallbackPageNotice)}</div>` : ""}${failedPageNotice ? `<div class="pdf-import-progress-detail">${e(failedPageNotice)}</div>` : ""}${reason ? `<div class="pdf-import-progress-detail">${e(reason)}</div>` : ""}</div>`;
}

// A single status stream per book serves both the shelf and import dialog.
// It only observes the task; disposing a view never stops the conversion.
export function watchPDFImport(book, scope, update) {
  const id = book.pdf?.book_id ?? book.book_id ?? book.id;
  if (id == null || scope.signal.aborted) return () => {};
  const key = String(id);
  let stream = streams.get(key);
  if (!stream) {
    stream = { book, listeners: new Set(), timer: null, request: null, stale: false };
    streams.set(key, stream);
    const schedule = () => {
      clearTimeout(stream.timer);
      if (!stream.listeners.size || document.hidden) return;
      const pdf = stream.book.pdf || {};
      const task = pdf.task || stream.book.task || {};
      const working = workingStates.has(task.state);
      if (!stream.stale && !working && !pdf.bridge_error && !task.error && pdf.ready_pages >= pdf.page_count && pdf.page_count > 0) return;
      stream.timer = setTimeout(poll, stream.stale ? 5000 : working ? 1800 : 15000);
    };
    const poll = async () => {
      if (stream.request || !stream.listeners.size || document.hidden) return;
      const request = (stream.request = new AbortController());
      try {
        const next = await api(`/pdf/books/${encodeURIComponent(key)}`, { signal: request.signal });
        if (!next.pdf || String(next.pdf.book_id) !== key)
          throw new Error("PDF status identity mismatch");
        stream.book = next;
        stream.stale = false;
      } catch (error) {
        if (request.signal.aborted) return;
        stream.stale = true;
      } finally {
        stream.request = null;
      }
      for (const listener of stream.listeners) listener(stream.book, { stale: stream.stale });
      schedule();
    };
    stream.visibility = () => {
      clearTimeout(stream.timer);
      if (!document.hidden) void poll();
    };
    stream.schedule = schedule;
    document.addEventListener("visibilitychange", stream.visibility);
  }
  stream.listeners.add(update);
  update(stream.book, { stale: stream.stale });
  stream.schedule();
  const dispose = () => {
    if (!stream.listeners.delete(update) || stream.listeners.size) return;
    clearTimeout(stream.timer);
    stream.request?.abort();
    document.removeEventListener("visibilitychange", stream.visibility);
    streams.delete(key);
  };
  scope.cleanup(dispose);
  return dispose;
}
