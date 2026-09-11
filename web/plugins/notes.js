(() => {
  WR.addNav({ href: "#/notes", label: "笔记" });
  WR.addRoute("/notes", renderNotes);

  WR.on("read", ({ id, article, below }) => {
    if (!article || !below) return;
    below.insertAdjacentHTML("beforeend", `
      <section class="card" id="wr-note-box">
        <h3>笔记</h3>
        <p class="hint">划一段原文，点保存。也可直接写。</p>
        <input id="wr-quote" type="text" placeholder="摘录（可空）" />
        <textarea id="wr-nbody" placeholder="这一段我想记住…"></textarea>
        <div class="row"><button type="button" id="wr-nsave">记下</button></div>
        <ul class="list" id="wr-nlist"></ul>
      </section>`);
    article.addEventListener("mouseup", () => {
      const q = window.getSelection()?.toString().trim();
      if (q) document.getElementById("wr-quote").value = q.slice(0, 240);
    });
    document.getElementById("wr-nsave").onclick = async () => {
      const body = document.getElementById("wr-nbody").value.trim();
      if (!body) return WR.toast("写一点内容");
      await WR.api("/api/notes", {
        method: "POST",
        body: { doc_id: id, quote: document.getElementById("wr-quote").value, body },
      });
      document.getElementById("wr-nbody").value = "";
      WR.toast("已记下");
      await paintList(id);
    };
    paintList(id);
  });

  async function paintList(docId) {
    const ul = document.getElementById("wr-nlist");
    if (!ul) return;
    const rows = await WR.api(`/api/notes?doc_id=${docId}`);
    ul.innerHTML = rows.map((n) => `<li><span>${WR.escapeHtml(n.body)}${n.quote ? `<span class="meta"> · ${WR.escapeHtml(n.quote.slice(0, 40))}</span>` : ""}</span>
      <button class="ghost" data-del="${n.id}">删</button></li>`).join("") || "<li>还没有笔记</li>";
    ul.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = async () => {
        await WR.api(`/api/notes/${b.dataset.del}`, { method: "DELETE" });
        paintList(docId);
      };
    });
  }

  async function renderNotes() {
    const rows = await WR.api("/api/notes");
    const app = document.getElementById("app");
    app.innerHTML = `
      <h2>全部笔记</h2>
      <ul class="list">
        ${rows.map((n) => `<li>
          <span><a href="#/read/${n.doc_id}">${WR.escapeHtml(n.title || "#" + n.doc_id)}</a>
            <div>${WR.escapeHtml(n.body)}</div>
            ${n.quote ? `<p class="hint">「${WR.escapeHtml(n.quote)}」</p>` : ""}</span>
          <button class="ghost" data-del="${n.id}">删</button>
        </li>`).join("") || "<li>还没有笔记</li>"}
      </ul>`;
    app.querySelectorAll("[data-del]").forEach((b) => {
      b.onclick = async () => {
        await WR.api(`/api/notes/${b.dataset.del}`, { method: "DELETE" });
        renderNotes();
      };
    });
  }
})();
