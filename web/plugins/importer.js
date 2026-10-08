import { $, api, e } from "../core.js";
export function install(ctx) {
  return ctx.hook("importDialog", (dialog) => {
    $("#import-extension", dialog).innerHTML =
      '<label class="dropzone">↥　导入 EPUB / TXT / Markdown<input id="upload-file" type="file" accept=".epub,.zip,.txt,.md,.markdown" aria-label="选择阅读文件"></label><p class="dialog-hint">兼容 Mac EPUB 文件包及其 ZIP。最大 20 MB，最多 500 章。<br>保留标题、段落、列表和代码；图片显示替代文字。<br><a href="/static/sample.epub" download>下载示例 EPUB ↗</a><br>或直接粘贴英文：</p><div id="upload-state" role="status"></div>';
    const input = $("#upload-file", dialog);
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const el = $("#upload-state", dialog);
      if (file.size > 20 * 1024 * 1024) {
        el.innerHTML =
          '<div class="notice error">文件超过 20 MB，请拆分后导入。</div>';
        return;
      }
      input.disabled = true;
      el.innerHTML =
        '<div class="notice">正在检查文件并整理章节，请稍候…</div>';
      const body = new FormData();
      body.append("file", file);
      try {
        const result = await api("/import", { method: "POST", body });
        // Import already persisted the book. Refresh independently of closing
        // the dialog or choosing Start Reading, without interrupting a reader.
        if (!location.hash || /^#\/?$/.test(location.hash)) ctx.refresh();
        // The shared dialog may have been repurposed while the upload ran.
        if ($("#upload-file", dialog) !== input) return;
        el.innerHTML = `<div class="notice">已完整导入 ${result.chapters.length} 章。${e(result.notice || "")}<p style="margin:12px 0 0"><button id="open-import" class="primary">开始阅读 →</button></p></div>`;
        $("#open-import", el).onclick = () => {
          dialog.close();
          ctx.navigate("#/read/" + result.chapters[0].doc_id);
        };
      } catch (err) {
        if ($("#upload-file", dialog) === input)
          el.innerHTML = `<div class="notice error">${e(err.message)}</div>`;
      } finally {
        input.disabled = false;
        input.value = "";
      }
    };
  });
}
