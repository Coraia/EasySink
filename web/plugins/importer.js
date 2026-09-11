import { $, api, e } from "../core.js";
export function install(ctx) {
  return ctx.hook("importDialog", (dialog) => {
    $("#import-extension", dialog).innerHTML =
      '<label class="dropzone">↥　导入 EPUB / TXT / Markdown<input id="upload-file" type="file" accept=".epub,.txt,.md,.markdown" aria-label="选择阅读文件"></label><p class="dialog-hint">最大 20 MB，最多 500 章。保留标题、段落、列表和代码；图片显示替代文字。<br><a href="/static/sample.epub" download>下载示例 EPUB ↗</a><br>或直接粘贴英文：</p><div id="upload-state" role="status"></div>';
    $("#upload-file", dialog).onchange = async (ev) => {
      const file = ev.target.files[0];
      if (!file) return;
      const el = $("#upload-state", dialog);
      if (file.size > 20 * 1024 * 1024) {
        el.innerHTML =
          '<div class="notice error">文件超过 20 MB，请拆分后导入。</div>';
        return;
      }
      ev.target.disabled = true;
      el.innerHTML =
        '<div class="notice">正在检查文件并整理章节，请稍候…</div>';
      const body = new FormData();
      body.append("file", file);
      try {
        const result = await api("/import", { method: "POST", body });
        el.innerHTML = `<div class="notice">已完整导入 ${result.chapters.length} 章。${e(result.notice || "")}<p style="margin:12px 0 0"><button id="open-import" class="primary">开始阅读 →</button></p></div>`;
        $("#open-import", el).onclick = () => {
          dialog.close();
          ctx.navigate(
            ctx.enabled("library")
              ? "#/book/" + result.book_id
              : "#/read/" + result.chapters[0].doc_id,
          );
        };
      } catch (err) {
        el.innerHTML = `<div class="notice error">${e(err.message)}</div>`;
      } finally {
        ev.target.disabled = false;
        ev.target.value = "";
      }
    };
  });
}
