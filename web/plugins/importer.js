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
      '<div class="row wrap"><label>PDF 处理位置 <select id="pdf-import-engine" aria-describedby="pdf-import-location"><option value="auto" selected>当前电脑（默认）</option><option value="omarchy" disabled>Omarchy · GPU OCR（正在检查）</option></select></label><button type="button" id="pdf-import-capabilities-retry" class="text-button" hidden>重新检查</button></div><p id="pdf-import-location" class="dialog-hint" role="status">PDF 在当前电脑处理。正在检查 Omarchy 是否可用；此选项仅影响 PDF。</p><label class="dropzone">↥　导入 PDF / EPUB / TXT / Markdown<input id="upload-file" type="file" accept=".pdf,application/pdf,.epub,.zip,.txt,.md,.markdown" aria-label="选择阅读文件"></label><p class="dialog-hint">PDF 最大 256 MiB，原件登记后即保存在书架，阅读版逐步准备；可以关闭这里。<br>EPUB / TXT / Markdown 最大 20 MB，最多 500 章；兼容 Mac EPUB 文件包及其 ZIP。保留标题、段落、列表和代码；旧格式图片显示替代文字。<br><a href="/static/sample.epub" download>下载示例 EPUB ↗</a><br>或直接粘贴英文：</p><div id="upload-state" role="status"></div>';
    const input = $("#upload-file", dialog);
    const engine = $("#pdf-import-engine", dialog);
    const locationHint = $("#pdf-import-location", dialog);
    const retryCapabilities = $("#pdf-import-capabilities-retry", dialog);
    let omarchy = { available: false, reason: "正在检查 Omarchy 是否可用。" };
    let checkingCapabilities = false;
    let stopProgress = () => {};
    const current = () =>
      active && !scope.signal.aborted && $("#upload-file", dialog) === input;
    const updateLocation = () => {
      if (!current()) return;
      const remote = engine.querySelector('[value="omarchy"]');
      remote.disabled = !omarchy.available;
      remote.textContent = `Omarchy · GPU OCR${omarchy.available ? "" : checkingCapabilities ? "（正在检查）" : "（暂不可用）"}`;
      locationHint.textContent = engine.value === "omarchy"
        ? `在你的 Omarchy 上识别，无付费 API。选择 PDF 后将发送整份文件到该服务器。${omarchy.available ? "" : ` ${omarchy.reason}`}`
        : `PDF 在当前电脑处理；此选项仅影响 PDF。${omarchy.available ? "也可选择你的 Omarchy，无付费 API。" : ` ${omarchy.reason}`}`;
      retryCapabilities.hidden = omarchy.available || checkingCapabilities;
    };
    const loadCapabilities = async () => {
      if (!current() || checkingCapabilities || input.disabled) return;
      checkingCapabilities = true;
      omarchy = { available: false, reason: "正在检查 Omarchy 是否可用。" };
      updateLocation();
      const request = new AbortController();
      const abort = () => request.abort();
      scope.signal.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(abort, 8000);
      try {
        const caps = await api("/pdf/capabilities", { signal: request.signal });
        const adapter = Array.isArray(caps?.adapters)
          ? caps.adapters.find((item) => item?.id === "omarchy")
          : null;
        omarchy = {
          available: caps?.processing_enabled !== false && adapter?.available === true,
          reason: caps?.processing_enabled === false
            ? "PDF 处理已关闭，需开启后再导入。"
            : typeof adapter?.missing_reason === "string" && adapter.missing_reason
              ? `Omarchy 暂不可用：${adapter.missing_reason}`
              : !adapter ? "当前服务未提供 Omarchy 处理能力。"
                : adapter.available === false ? "Omarchy 尚未就绪。"
                  : "服务尚未确认 Omarchy 是否可用。",
        };
      } catch (error) {
        omarchy = {
          available: false,
          reason: request.signal.aborted
            ? "Omarchy 可用性检查超时，可继续在当前电脑导入。"
            : `无法检查 Omarchy：${error.message} 可继续在当前电脑导入。`,
        };
      } finally {
        clearTimeout(timeout);
        scope.signal.removeEventListener("abort", abort);
        checkingCapabilities = false;
        updateLocation();
      }
    };
    scope.on(engine, "change", updateLocation);
    scope.on(retryCapabilities, "click", loadCapabilities);
    void loadCapabilities();
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
      if (isPDF && selectedEngine !== "auto" &&
          (selectedEngine !== "omarchy" || !omarchy.available)) {
        el.innerHTML = `<div class="notice error">${e(omarchy.reason)} 请重新检查，或选择当前电脑后重新选择文件。</div>`;
        input.value = "";
        return;
      }
      input.disabled = true;
      engine.disabled = true;
      retryCapabilities.disabled = true;
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
          el.innerHTML = `<div class="notice pdf-import-notice"><p class="pdf-import-saved">${result.reused ? "这份 PDF 已在书架，已复用同一书籍。" : "PDF 已保存在书架"}</p>${result.reused ? '<p class="dialog-hint">已保留原任务的处理位置；如需改用 Omarchy，请在 PDF 处理中选择并启动。</p>' : ""}<div data-import-progress></div><div class="row wrap"><button id="open-import" class="primary">查看准备状态 →</button>${result.reused ? '<button id="manage-import">PDF 处理</button>' : ""}<button id="close-import">关闭，留在书架</button></div></div>`;
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
          href = "#/read/" + result.chapters[0].doc_id;
          el.innerHTML = `<div class="notice">已完整导入 ${result.chapters.length} 章。${e(result.notice || "")}<p style="margin:12px 0 0"><button id="open-import" class="primary">开始阅读 →</button></p></div>`;
        }
        $("#open-import", el).onclick = () => {
          if (!current()) return;
          dialog.close();
          ctx.navigate(href);
        };
      } catch (err) {
        if (current())
          el.innerHTML = `<div class="notice error">${e(err.message)}${isPDF ? "<br>若接收响应中断，请先刷新书架核对已有书籍。" : ""}</div>`;
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
