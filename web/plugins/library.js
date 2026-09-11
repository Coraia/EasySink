(() => {
  WR.addNav({ href: "#/library", label: "书架" });
  WR.addRoute("/library", (path) => {
    const id = path.split("/")[2];
    return id ? renderBook(id) : renderShelf();
  });

  async function renderShelf() {
    const books = await WR.api("/api/library/books");
    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="page-head"><div><h2>书架</h2>
      <p class="hint">导入的 EPUB/TXT 会出现在这里。粘贴的单篇仍在「历史」。</p></div></div>
      <ul class="list">
        ${books.map((b) => `<li>
          <a href="#/library/${b.id}">${WR.escapeHtml(b.title)}</a>
          <span class="meta">${b.chapter_count} 章 · ${WR.escapeHtml(b.author || b.source)}</span>
        </li>`).join("") || "<li>还没有书。去首页导入，或打开实验室确认 importer 已开。</li>"}
      </ul>`;
  }

  async function renderBook(id) {
    const b = await WR.api(`/api/library/books/${id}`);
    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="page-head"><div>
        <p class="meta"><a href="#/library">← 书架</a></p>
        <h2>${WR.escapeHtml(b.title)}</h2>
        <p class="hint">${WR.escapeHtml(b.author || "")} · ${WR.escapeHtml(b.source)}</p>
      </div>
      <button class="ghost" id="del">删除此书</button></div>
      <ul class="list">
        ${b.chapters.map((c, i) => `<li>
          <a href="#/read/${c.doc_id}">${i + 1}. ${WR.escapeHtml(c.title)}</a>
          <span class="meta">${c.word_count} 词</span>
        </li>`).join("")}
      </ul>`;
    document.getElementById("del").onclick = async () => {
      if (!confirm("删除书以及其中章节？")) return;
      await WR.api(`/api/library/books/${id}`, { method: "DELETE" });
      location.hash = "#/library";
    };
  }
})();
