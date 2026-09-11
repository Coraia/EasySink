(() => {
  WR.addNav({ href: "#/bookmarks", label: "书签" });
  WR.addRoute("/bookmarks", renderAll);

  WR.on("read", ({ id, toolbar }) => {
    if (!toolbar) return;
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = "书签";
    b.onclick = async () => {
      const ratio = WR.scrollRatio();
      await WR.api("/api/bookmarks", {
        method: "POST",
        body: { doc_id: id, scroll_ratio: ratio, label: `${Math.round(ratio * 100)}%` },
      });
      WR.toast("已加书签");
    };
    toolbar.appendChild(b);
  });

  async function renderAll() {
    const rows = await WR.api("/api/bookmarks");
    const app = document.getElementById("app");
    app.innerHTML = `
      <h2>书签</h2>
      <ul class="list">
        ${rows.map((x) => `<li>
          <a href="#/read/${x.doc_id}?at=${encodeURIComponent(x.scroll_ratio)}">${WR.escapeHtml(x.title || "#" + x.doc_id)} · ${WR.escapeHtml(x.label)}</a>
          <button class="ghost" data-del="${x.id}">删</button>
        </li>`).join("") || "<li>还没有书签</li>"}
      </ul>`;
    app.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = async () => {
        await WR.api(`/api/bookmarks/${btn.dataset.del}`, { method: "DELETE" });
        renderAll();
      };
    });
  }
})();
