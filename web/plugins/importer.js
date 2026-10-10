import { $, api, e, Scope } from "../core.js";
import { pdfImportProgress, watchPDFImport } from "./pdf-import-progress.js";

function readingDocument(id) {
  if (typeof id !== "number" && typeof id !== "string") return null;
  const value = Number(id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function install(ctx) {
  let active = true;
  let dialogScope = null;
  const unhook = ctx.hook("importDialog", (dialog) => {
    dialogScope?.dispose();
    const scope = (dialogScope = new Scope());
    scope.on(dialog, "close", () => scope.dispose());
    $("#import-extension", dialog).innerHTML =
      '<div class="row wrap"><label>PDF 处理位置 <select id="pdf-import-engine" aria-describedby="pdf-import-location"><option value="auto" selected>当前电脑（默认）</option><option value="mineru_source" disabled>当前电脑 · 公式与复杂排版（原式优先）（正在检查）</option><option value="omarchy" disabled>Omarchy · GPU OCR（正在检查）</option></select></label><button type="button" id="pdf-import-capabilities-retry" class="text-button">刷新状态</button></div><div id="pdf-import-service-status" class="notice" role="status" aria-live="polite">正在检查 PDF 处理服务…</div><p id="pdf-import-location" class="dialog-hint" role="status">PDF 默认在当前电脑快速处理。公式与复杂排版可选择原式优先模式；此选项仅影响 PDF。</p><label class="dropzone">↥　导入 PDF / EPUB / TXT / Markdown<input id="upload-file" type="file" accept=".pdf,application/pdf,.epub,.zip,.txt,.md,.markdown" aria-label="选择阅读文件"></label><p class="dialog-hint">PDF 最大 256 MiB，原件登记后即保存在书架，阅读版逐步准备；可以关闭这里。<br>EPUB / TXT / Markdown 最大 20 MB，最多 500 章；兼容 Mac EPUB 文件包及其 ZIP。保留标题、段落、列表和代码；旧格式图片显示替代文字。<br><a href="/static/sample.epub" download>下载示例 EPUB ↗</a><br>或直接粘贴英文：</p><div id="upload-state" role="status"></div>';
    const input = $("#upload-file", dialog);
    const engine = $("#pdf-import-engine", dialog);
    const locationHint = $("#pdf-import-location", dialog);
    const retryCapabilities = $("#pdf-import-capabilities-retry", dialog);
    const serviceStatus = $("#pdf-import-service-status", dialog);
    let caps = null;
    let checkedAt = null;
    let checkError = "";
    let capabilityRequest = null;
    let checkingCapabilities = false;
    let refreshTimer = null;
    let stopProgress = () => {};
    const current = () =>
      active && !scope.signal.aborted && $("#upload-file", dialog) === input;
    const adapter = (id) => caps?.adapters?.find((item) => item?.id === id);
    const available = (id) => caps?.processing_enabled !== false && adapter(id)?.available === true &&
      (id !== "omarchy" || adapter(id)?.readiness?.state === "ready");
    const updateLocation = () => {
      if (!current()) return;
      const remote = engine.querySelector('[value="omarchy"]');
      const formula = engine.querySelector('[value="mineru_source"]');
      // Keep a selected unavailable location visible. Never silently switch the
      // file's processing location, and never disable the shared EPUB input.
      remote.disabled = !available("omarchy");
      remote.textContent = `Omarchy · GPU OCR${available("omarchy") ? "" : checkingCapabilities ? "（正在检查）" : "（暂不可用）"}`;
      formula.disabled = !available("mineru_source");
      formula.textContent = `当前电脑 · 公式与复杂排版（原式优先）${available("mineru_source") ? "" : checkingCapabilities ? "（正在检查）" : "（模型未准备）"}`;
      locationHint.textContent = engine.value === "omarchy"
        ? "在你的 Omarchy 上识别，无付费 API。选择 PDF 后将发送整份文件到该服务器。"
        : engine.value === "mineru_source"
          ? "当前电脑处理公式与复杂排版；公式保留高清原式，阅读时点击才识别公式。此模式比默认文字提取更慢。"
          : "PDF 默认在当前电脑快速处理；公式或复杂排版可选择原式优先模式。此选项仅影响 PDF。";
      retryCapabilities.disabled = checkingCapabilities || input.disabled;
      retryCapabilities.textContent = checkingCapabilities ? "检查中…" : "刷新状态";
      if (checkingCapabilities) {
        serviceStatus.innerHTML = '<span>正在检查模型与服务状态…</span><div class="dialog-hint">提交 PDF 前会再次检查；EPUB / TXT / Markdown 不受影响。</div>';
        return;
      }
      const disabled = caps?.processing_enabled === false;
      const local = disabled ? "PDF 处理已关闭" : available("digital")
        ? available("docling") ? "文字提取 / 扫描 OCR 已准备" : "文字提取可用；扫描 OCR 未准备，将保留原图"
        : checkError || adapter("digital")?.missing_reason || "本机 PDF 组件未准备好";
      const readiness = adapter("omarchy")?.readiness;
      const gpu = readiness?.gpu;
      const remoteDetail = disabled ? "PDF 处理已关闭" : available("omarchy")
        ? `专用 OCR 启动条件已就绪${Number.isFinite(gpu?.free_mib) ? ` · 空闲显存 ${(gpu.free_mib / 1024).toFixed(1)} GiB` : ""}`
        : checkError || adapter("omarchy")?.missing_reason || "尚未确认 Omarchy 是否可用";
      const formulaDetail = disabled ? "PDF 处理已关闭" : available("mineru_source")
        ? "可用 · 原式保留，公式按需识别"
        : checkError || adapter("mineru_source")?.missing_reason || "模型未准备，暂不可用";
      const stamp = checkedAt ? new Date(checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "";
      serviceStatus.innerHTML = `<div data-pdf-local-state="${available("digital") ? "ready" : "unavailable"}"><strong>当前电脑</strong> · ${e(local)}</div><div data-pdf-formula-state="${available("mineru_source") ? "ready" : "unavailable"}"><strong>公式与复杂排版（原式优先）</strong> · ${e(formulaDetail)}</div><div data-pdf-remote-state="${e(readiness?.state || (available("omarchy") ? "ready" : "unknown"))}"><strong>Omarchy</strong> · ${e(remoteDetail)}</div><div class="dialog-hint">${stamp ? `${e(stamp)} 检查 · ` : ""}提交前再次核验；EPUB / TXT / Markdown 不受影响。</div>`;
    };
    const loadCapabilities = () => {
      if (!current()) return Promise.resolve(null);
      if (capabilityRequest) return capabilityRequest;
      checkingCapabilities = true;
      updateLocation();
      capabilityRequest = (async () => {
        const request = new AbortController();
        const abort = () => request.abort();
        scope.signal.addEventListener("abort", abort, { once: true });
        const timeout = setTimeout(abort, 10000);
        try {
          const next = await api(`/pdf/capabilities?check=${Date.now()}`, { signal: request.signal });
          if (!Array.isArray(next?.adapters)) throw new Error("服务状态响应不完整");
          if (current()) { caps = next; checkError = ""; checkedAt = Date.now(); }
          return next;
        } catch (error) {
          if (current()) {
            caps = null;
            checkError = request.signal.aborted ? "检查超时，请刷新状态后再试" : "暂时无法取得 PDF 服务状态，请刷新后再试";
            checkedAt = Date.now();
          }
          return null;
        } finally {
          clearTimeout(timeout);
          scope.signal.removeEventListener("abort", abort);
          checkingCapabilities = false;
          updateLocation();
        }
      })().finally(() => { capabilityRequest = null; });
      return capabilityRequest;
    };
    scope.on(engine, "change", updateLocation);
    scope.on(retryCapabilities, "click", () => void loadCapabilities());
    // A visible, idle dialog keeps its snapshot fresh without watching hidden
    // tabs or disturbing the independent persisted import-progress stream.
    const scheduleRefresh = () => {
      clearTimeout(refreshTimer);
      if (!current()) return;
      refreshTimer = setTimeout(async () => {
        if (!document.hidden && !input.disabled) await loadCapabilities();
        scheduleRefresh();
      }, 20000);
    };
    scope.cleanup(() => clearTimeout(refreshTimer));
    scope.on(document, "visibilitychange", () => {
      if (!document.hidden && current() && !input.disabled) void loadCapabilities();
    });
    void loadCapabilities();
    scheduleRefresh();
    input.onchange = async () => {
      if (!current() || input.disabled) return;
      const file = input.files[0];
      if (!file) return;
      const isPDF =
        /\.pdf$/i.test(file.name) || file.type === "application/pdf";
      const el = $("#upload-state", dialog);
      stopProgress();
      const limit = (isPDF ? 256 : 20) * 1024 * 1024;
      if (file.size > limit) {
        el.innerHTML = `<div class="notice error">${isPDF ? "PDF 超过 256 MiB，请选择较小的文件。" : "文件超过 20 MB，请拆分后导入。"}</div>`;
        return;
      }
      const selectedEngine = engine.value;
      input.disabled = true;
      engine.disabled = true;
      retryCapabilities.disabled = true;
      if (isPDF) {
        el.innerHTML = '<div class="notice">正在再次检查 PDF 处理服务…</div>';
        // An earlier open-dialog request is not the fresh submission check.
        if (capabilityRequest) await capabilityRequest;
        const latest = await loadCapabilities();
        if (!current()) return;
        const selected = latest?.adapters?.find((item) => item?.id === (selectedEngine === "auto" ? "digital" : selectedEngine));
        if (!latest || latest.processing_enabled === false || selected?.available !== true) {
          const reason = latest?.processing_enabled === false ? "PDF 处理已关闭，请开启后再导入。"
            : checkError || selected?.missing_reason || "所选 PDF 处理服务尚未就绪。";
          el.innerHTML = `<div class="notice error">${e(reason)}<br>本次尚未上传。可刷新状态，或选择其他处理位置后重新选择文件。</div>`;
          input.disabled = false;
          engine.disabled = false;
          input.value = "";
          updateLocation();
          return;
        }
      }
      el.innerHTML = `<div class="notice">${isPDF ? `正在接收 PDF 原件并登记书籍。${selectedEngine === "omarchy" ? "已选择在你的 Omarchy 上识别，无付费 API。" : "已选择在当前电脑处理。"}阅读版状态单独提供，可以关闭这里。` : "正在检查文件并整理章节，请稍候…"}</div>`;
      const body = new FormData();
      body.append("file", file);
      if (isPDF) body.append("engine", selectedEngine);
      try {
        // A dialog's lifetime controls its UI, not the persistent import.
        const result = await api(isPDF ? "/pdf/imports" : "/import", {
          method: "POST",
          body,
        });
        // Import already persisted the book. Refresh independently of closing
        // the dialog or choosing Start Reading, without interrupting a reader.
        if (active && (!location.hash || /^#\/?$/.test(location.hash)))
          ctx.refresh();
        // The shared dialog may have been repurposed while the upload ran.
        if (!current()) return;
        let href;
        if (isPDF) {
          const bookId = result.book_id ?? result.pdf?.book_id;
          if (bookId === undefined || bookId === null || bookId === "")
            throw new Error("接收响应没有书籍身份，请刷新书架核对登记结果。");
          if (result.pdf?.lifecycle === "recycled") {
            el.innerHTML =
              '<div class="notice">这份 PDF 在回收站，原件、已有内容和记录仍保留。<p style="margin:12px 0 0"><button id="restore-import" class="primary">恢复书籍</button> <button id="open-pdf-recycle">查看回收站</button> <button id="close-import">关闭</button></p><p id="restore-import-state" role="status"></p></div>';
            scope.on($("#close-import", el), "click", () => dialog.close());
            scope.on($("#open-pdf-recycle", el), "click", () => {
              dialog.close();
              ctx.navigate("#/pdf-recycle");
            });
            scope.on($("#restore-import", el), "click", async (event) => {
              const button = event.currentTarget;
              if (button.disabled || !current()) return;
              button.disabled = true;
              button.textContent = "恢复中…";
              input.disabled = true;
              engine.disabled = true;
              retryCapabilities.disabled = true;
              try {
                const restored = await api(
                  `/pdf/books/${encodeURIComponent(bookId)}/lifecycle`,
                  { method: "POST", body: { action: "restore" } },
                );
                if (restored.pdf?.lifecycle === "recycled")
                  throw new Error("书籍仍在回收站，请刷新清单核对。");
                if (!current()) {
                  if (
                    active &&
                    (!location.hash || /^#\/?$/.test(location.hash))
                  )
                    ctx.refresh();
                  return;
                }
                dialog.close();
                ctx.navigate("#/");
              } catch (error) {
                if (current()) {
                  $("#restore-import-state", el).textContent =
                    `${error.message} 请刷新回收站核对实际状态。`;
                  button.disabled = false;
                  button.textContent = "恢复书籍";
                }
              } finally {
                if (current()) {
                  input.disabled = false;
                  engine.disabled = false;
                  retryCapabilities.disabled = false;
                }
              }
            });
            return;
          }
          el.innerHTML = `<div class="notice pdf-import-notice"><p class="pdf-import-saved">${result.reused ? "这份 PDF 已在书架，已复用同一书籍。" : "PDF 已保存在书架"}</p>${result.reused ? '<p class="dialog-hint">已保留原任务的处理位置；如需改用原式优先模式或 Omarchy，请在 PDF 处理中选择并启动。</p>' : ""}<div data-import-progress></div><div class="row wrap"><button id="open-import" class="primary">查看准备状态 →</button>${result.reused ? '<button id="manage-import">PDF 处理</button>' : ""}<button id="close-import">关闭，留在书架</button></div></div>`;
          scope.on($("#close-import", el), "click", () => dialog.close());
          scope.on($("#manage-import", el), "click", () => {
            dialog.close();
            ctx.navigate(`#/pdf-status/${encodeURIComponent(bookId)}`);
          });
          stopProgress = watchPDFImport(result, scope, (next, state) => {
            if (!current()) return;
            const docId = next.pdf?.lifecycle === "recycled" ? null : readingDocument(next.pdf?.reading_doc_id);
            href = docId ? `#/read/${docId}` : `#/pdf/${encodeURIComponent(bookId)}`;
            const progress = $("[data-import-progress]", el);
            const html = pdfImportProgress(next, state);
            if (progress.innerHTML !== html) progress.innerHTML = html;
            $("#open-import", el).textContent = docId ? "打开阅读版 →" : "查看准备状态 →";
          });
        } else {
          href = "#/read/" + (readingDocument(result.reading_doc_id) || result.chapters[0].doc_id);
          el.innerHTML = `<div class="notice">${result.reused ? "这本 EPUB 已在书架，已复用已有书籍。" : `已完整导入 ${result.chapters.length} 章。`}${e(result.notice || "")}<p style="margin:12px 0 0"><button id="open-import" class="primary">${result.reused ? "继续阅读" : "开始阅读"} →</button> <button id="close-import">关闭，留在书架</button></p></div>`;
          scope.on($("#close-import", el), "click", () => dialog.close());
        }
        $("#open-import", el).onclick = () => {
          if (!current()) return;
          dialog.close();
          ctx.navigate(href);
        };
      } catch (err) {
        if (current()) {
          const pdfMessages = {
            format_unreadable: "PDF 文件损坏、不完整或格式无法读取，尚未导入。请换一个可正常打开的原文件。",
            access_restricted: "PDF 需要密码，尚未导入。请先解锁文件后再导入。",
            validator_timeout: "读取 PDF 超时，尚未导入。可以重新选择文件再试。",
            validator_unavailable: "本机 PDF 读取组件暂不可用，尚未导入。请重新打开应用后再试。",
            space_insufficient: "本机可用空间不足，尚未导入。请释放空间后重试。",
            upload_too_large: "PDF 超过 256 MiB，请选择较小的文件。",
            page_limit: "PDF 超过 10,000 页，尚未导入。请拆分后再试。",
          };
          const message = isPDF && pdfMessages[err.code] || err.message;
          const uncertain = isPDF && !pdfMessages[err.code] && (!err.status || err.status >= 500);
          el.innerHTML = `<div class="notice error">${e(message)}${uncertain ? "<br>若接收响应中断，请先刷新书架核对已有书籍。" : ""}</div>`;
        }
      } finally {
        if (current()) {
          input.disabled = false;
          engine.disabled = false;
          retryCapabilities.disabled = false;
          input.value = "";
        }
      }
    };
  });
  return () => {
    active = false;
    dialogScope?.dispose();
    unhook();
  };
}
