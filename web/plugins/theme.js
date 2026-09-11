(() => {
  const KEY = "wr.theme";
  const THEMES = [
    { id: "paper", label: "纸色" },
    { id: "sepia", label: "羊皮纸" },
    { id: "night", label: "夜间" },
  ];

  function apply(id) {
    document.documentElement.dataset.theme = id === "paper" ? "" : id;
    if (!id || id === "paper") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = id;
    localStorage.setItem(KEY, id);
  }

  apply(localStorage.getItem(KEY) || "paper");

  WR.on("profile", ({ root }) => {
    if (!root) return;
    root.insertAdjacentHTML("beforeend", `
      <section class="card">
        <h3>主题</h3>
        <div class="chips" id="wr-themes">
          ${THEMES.map((t) => `<button type="button" class="chip" data-th="${t.id}">${t.label}</button>`).join("")}
        </div>
      </section>`);
    const cur = localStorage.getItem(KEY) || "paper";
    root.querySelectorAll("[data-th]").forEach((el) => {
      el.classList.toggle("on", el.dataset.th === cur);
      el.onclick = () => {
        apply(el.dataset.th);
        root.querySelectorAll("[data-th]").forEach((x) => x.classList.toggle("on", x === el));
      };
    });
  });
})();
