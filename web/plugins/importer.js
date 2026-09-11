(() => {
  WR.on("home", ({ root }) => {
    if (!root) return;
    root.insertAdjacentHTML("beforeend", `
      <section class="card">
        <h3>导入文件</h3>
        <p class="hint">EPUB / TXT / Markdown。EPUB 会按章节拆开，放进书架。</p>
        <input id="wr-file" type="file" accept=".epub,.txt,.md,.markdown,text/plain" />
        <div class="row"><button type="button" id="wr-imp">导入</button><span class="meta" id="wr-imp-msg"></span></div>
      </section>`);
    document.getElementById("wr-imp").onclick = async () => {
      const file = document.getElementById("wr-file").files[0];
      if (!file) return WR.toast("先选文件");
      const fd = new FormData();
      fd.append("file", file);
      const msg = document.getElementById("wr-imp-msg");
      msg.textContent = "处理中…";
      try {
        const r = await WR.api("/api/import", { method: "POST", body: fd });
        msg.textContent = `已导入 ${r.chapters.length} 章`;
        location.hash = WR.pluginOn("library")
          ? `#/library/${r.book_id}`
          : `#/read/${r.chapters[0].doc_id}`;
      } catch (e) {
        msg.textContent = "";
        WR.toast("导入失败 " + e.message);
      }
    };
  });
})();
