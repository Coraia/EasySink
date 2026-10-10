import { $, e } from "./core.js";
import { pdfAssetURL } from "./pdf-inline.js";

function targetFor(item, book) {
  const task = item.source?.conversion_task_id;
  return typeof task === "string" && task && typeof item.formula_id === "string" && item.formula_id &&
    (item.source?.book_id == null || String(item.source.book_id) === String(book))
    ? { task_id: task, formula_id: item.formula_id } : null;
}

export function formulaDetails(item, book) {
  const asset = pdfAssetURL(item.asset_url, book), target = targetFor(item, book);
  return `<section class="pdf-formula-details"><p class="meta">原式 · PDF 原页 ${e(item.source?.page_number || "—")}</p><div class="pdf-formula-preview">${asset ? `<img src="${e(asset)}" alt="公式原图放大" draggable="false">` : '<p class="meta">原式预览暂不可用，请核对原版。</p>'}</div><p class="pdf-formula-image-error meta" hidden>原式预览未能加载，请核对原版。</p><p class="meta">点击后在本机识别这一条公式，已有结果会直接复用。</p><button type="button" data-formula-recognize ${target ? "" : "disabled"}>识别公式</button><p class="pdf-formula-status meta" role="status" aria-live="polite">${target ? "原式始终保留，识别结果仅供对照。" : "这条原式暂无可识别的来源记录，仍可核对原版。"}</p><div class="pdf-formula-result" hidden><div class="pdf-formula-math" hidden></div><label>LaTeX<textarea class="pdf-formula-latex" readonly rows="3" spellcheck="false" aria-label="识别所得 LaTeX"></textarea></label><button type="button" data-formula-copy>复制 LaTeX</button></div></section>`;
}

// Use the reader's existing panel/scope so dismissal, notes and book navigation
// keep their established behavior. Opening this panel performs no API request.
export function placeFormulaPanel(scope, rect) {
  const panel = $("#tool-panel");
  panel.classList.add("pdf-object-menu", "pdf-formula-panel");
  const place = () => {
    if (scope.signal.aborted) return;
    const box = panel.getBoundingClientRect(), gap = 10;
    const below = (rect?.bottom || 40) + gap;
    const above = (rect?.top || 40) - gap - box.height;
    panel.style.left = `${Math.max(12, Math.min(rect?.left || 12, innerWidth - box.width - 12))}px`;
    panel.style.top = `${Math.max(12, Math.min(below + box.height <= innerHeight - 12 ? below : above, innerHeight - box.height - 12))}px`;
  };
  place();
  const resize = new ResizeObserver(place);
  resize.observe(panel);
  scope.on(window, "resize", place);
  scope.cleanup(() => {
    resize.disconnect();
    panel.classList.remove("pdf-object-menu", "pdf-formula-panel");
    panel.style.left = "";
    panel.style.top = "";
  });
}

export function mountFormulaDetails(pdf, item, el, scope) {
  const r = pdf.r, target = targetFor(item, pdf.book);
  const button = $("[data-formula-recognize]", el), state = $(".pdf-formula-status", el);
  const result = $(".pdf-formula-result", el), latex = $(".pdf-formula-latex", el);
  const base = `/pdf/books/${encodeURIComponent(pdf.book)}/formulas`;
  let timer, busy = false, jobID = null, lookupOnly = false;
  const alive = () => !scope.signal.aborted && !pdf.scope.signal.aborted;
  scope.cleanup(() => clearTimeout(timer));
  scope.on(pdf.scope.signal, "abort", () => scope.dispose(), { once: true });
  for (const name of ["before-page", "before-navigation", "draw"])
    scope.on(r.events, name, () => r.closePanel());
  const preview = $(".pdf-formula-preview img", el);
  scope.on(preview, "error", () => {
    $(".pdf-formula-image-error", el).hidden = false;
  });

  const renderJob = (job) => {
    if (!job || typeof job.id !== "string" || !job.id ||
        job.task_id !== target.task_id || job.formula_id !== target.formula_id ||
        String(job.book_id) !== String(pdf.book)) throw new Error("公式任务身份不匹配，请重新查询。");
    jobID = job.id;
    if (["queued", "running"].includes(job.status)) {
      state.textContent = job.status === "queued" ? "已排队，可继续阅读；关闭面板后任务仍会保留。" : "正在识别这一条公式，原式仍可核对。";
      button.textContent = "识别中…";
      button.disabled = true;
      timer = setTimeout(poll, 1200);
    } else if (job.status === "completed") {
      if (typeof job.latex !== "string" || !job.latex.trim()) throw new Error("任务已结束，但未返回有效 LaTeX。原式已保留。");
      latex.value = job.latex;
      result.hidden = false;
      button.textContent = job.cached ? "已缓存" : "已识别";
      button.disabled = true;
      state.textContent = job.cached ? "已缓存 · 复用已有结果，未重新识别。请与上方原式核对。" : "识别完成 · 结果已保存，请与上方原式核对。";
      const math = $(".pdf-formula-math", el);
      if (globalThis.katex?.render && job.latex.length <= 60000) {
        try {
          globalThis.katex.render(job.latex, math, { displayMode: true, trust: false,
            strict: "error", throwOnError: true, maxExpand: 1000, maxSize: 20 });
          math.hidden = false;
        } catch { math.replaceChildren(); math.hidden = true; }
      }
    } else if (["failed", "cancelled"].includes(job.status)) {
      state.textContent = `${job.error?.message || (job.status === "cancelled" ? "识别任务已取消。" : "公式暂未识别成功。")} 原式保留，可继续阅读。`;
      jobID = null;
      lookupOnly = false;
      button.textContent = "重试识别公式";
      button.disabled = false;
    } else throw new Error("公式任务状态暂无法确认，请重新查询已有任务。");
  };
  const fail = (error, posting = false) => {
    if (!alive() || error.name === "AbortError") return;
    clearTimeout(timer);
    // A lost POST response is unknown, not permission to resubmit inference.
    lookupOnly ||= !jobID && posting && (!error.status || (error.status >= 500 && !error.code));
    state.textContent = `${error.message} 原式保留，可继续阅读。`;
    button.textContent = jobID || lookupOnly ? "查询已有结果" : "重试识别公式";
    button.disabled = false;
  };
  async function poll() {
    if (!alive() || !jobID || busy) return;
    busy = true;
    try {
      const job = await pdf.api(`${base}/${encodeURIComponent(jobID)}`, { signal: scope.signal });
      if (alive()) renderJob(job);
    } catch (error) { fail(error); }
    finally { busy = false; }
  }
  scope.on(button, "click", async () => {
    if (!target || busy || button.disabled || !alive()) return;
    clearTimeout(timer);
    button.disabled = true;
    if (jobID) { await poll(); return; }
    busy = true;
    const posting = !lookupOnly;
    state.textContent = posting ? "正在提交这一条公式…" : "正在查询已有结果…";
    try {
      if (lookupOnly) {
        const query = new URLSearchParams(target);
        const data = await pdf.api(`${base}?${query}`, { signal: scope.signal });
        if (!alive()) return;
        if (data.job) renderJob(data.job);
        else {
          lookupOnly = false;
          button.disabled = false;
          button.textContent = "识别公式";
          state.textContent = "没有查到已有任务。点击“识别公式”可重新提交，原式始终保留。";
        }
      } else {
        const job = await pdf.api(base, { method: "POST", body: target, signal: scope.signal });
        if (alive()) renderJob(job);
      }
    } catch (error) { fail(error, posting); }
    finally { busy = false; }
  });
  scope.on($("[data-formula-copy]", el), "click", async (event) => {
    const copy = event.currentTarget;
    try {
      await navigator.clipboard.writeText(latex.value);
      if (alive()) copy.textContent = "已复制 LaTeX";
    } catch {
      if (!alive()) return;
      latex.focus(); latex.select();
      state.textContent = "LaTeX 已选中，请使用系统复制快捷键。";
    }
  });
}
