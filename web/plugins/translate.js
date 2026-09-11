(() => {
  WR.on("read", async ({ id, stage, toolbar, below }) => {
    if (!stage || !toolbar) return;
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = "译文";
    toolbar.appendChild(b);
    let pane = null;

    async function show(row) {
      if (!row || !row.body) {
        if (pane) pane.remove();
        pane = null;
        stage.classList.remove("reader-split");
        return;
      }
      if (!pane) {
        pane = document.createElement("article");
        pane.className = "article trans";
        pane.id = "wr-trans";
        stage.appendChild(pane);
      }
      pane.textContent = row.body;
      stage.classList.add("reader-split");
    }

    const existing = await WR.api(`/api/documents/${id}/translation`);
    if (existing.body) await show(existing);

    b.onclick = () => {
      let box = document.getElementById("wr-trans-box");
      if (box) {
        box.remove();
        return;
      }
      below.insertAdjacentHTML("afterbegin", `
        <section class="card" id="wr-trans-box">
          <h3>翻译书</h3>
          <p class="hint">对照阅读。无 LLM 时请粘贴译文；配了 API 可点生成。</p>
          <textarea id="wr-tbody" placeholder="粘贴中文译文">${existing.body ? WR.escapeHtml(existing.body) : ""}</textarea>
          <div class="row">
            <button type="button" id="wr-tsave">保存对照</button>
            <button type="button" class="ghost" id="wr-tgen">用 LLM 生成</button>
            <button type="button" class="ghost" id="wr-thide">隐藏译文</button>
          </div>
        </section>`);
      document.getElementById("wr-tsave").onclick = async () => {
        const body = document.getElementById("wr-tbody").value.trim();
        const row = await WR.api(`/api/documents/${id}/translation`, {
          method: "PUT",
          body: { lang: "zh", body, generate: false },
        });
        existing.body = row.body;
        await show(row);
        WR.toast("已保存译文");
      };
      document.getElementById("wr-tgen").onclick = async () => {
        WR.toast("生成中…");
        try {
          const row = await WR.api(`/api/documents/${id}/translation`, {
            method: "PUT",
            body: { lang: "zh", generate: true },
          });
          document.getElementById("wr-tbody").value = row.body;
          existing.body = row.body;
          await show(row);
          WR.toast("已生成");
        } catch (e) {
          WR.toast(e.message);
        }
      };
      document.getElementById("wr-thide").onclick = () => show(null);
    };
  });
})();
