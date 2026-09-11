(() => {
  WR.on("profile", ({ root }) => {
    if (!root) return;
    root.insertAdjacentHTML("beforeend", `
      <section class="card">
        <h3>导出</h3>
        <p class="hint">生词表 CSV，笔记 Markdown。</p>
        <div class="row">
          <a class="btn" href="/api/export/vocab.csv" download="vocab.csv">生词 CSV</a>
          <a class="btn" href="/api/export/notes.md" download="notes.md">笔记 MD</a>
        </div>
      </section>`);
  });
  WR.on("home", ({ root }) => {
    if (!root) return;
    root.insertAdjacentHTML("beforeend", `
      <p class="meta">也可在档案页导出生词和笔记。
        <a href="/api/export/vocab.csv" download>CSV</a> ·
        <a href="/api/export/notes.md" download>笔记</a></p>`);
  });
})();
