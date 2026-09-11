(() => {
  const KEY = "wr.type";

  function defaults() {
    return { size: 16, height: 1.9, width: 760 };
  }

  function load() {
    try { return { ...defaults(), ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
    catch { return defaults(); }
  }

  function apply(cfg) {
    document.documentElement.style.setProperty("--article-size", cfg.size + "px");
    document.documentElement.style.setProperty("--article-height", String(cfg.height));
    document.documentElement.style.setProperty("--page-width", cfg.width + "px");
    localStorage.setItem(KEY, JSON.stringify(cfg));
  }

  apply(load());

  WR.on("read", ({ below }) => {
    if (!below) return;
    const cfg = load();
    below.insertAdjacentHTML("beforeend", `
      <section class="card" id="wr-type">
        <h3>排版</h3>
        <label>字号 <span id="wr-sz">${cfg.size}</span></label>
        <input id="wr-size" type="range" min="14" max="24" step="1" value="${cfg.size}" />
        <label>行距 <span id="wr-lh">${cfg.height}</span></label>
        <input id="wr-height" type="range" min="1.5" max="2.4" step="0.1" value="${cfg.height}" />
        <label>栏宽 <span id="wr-wd">${cfg.width}</span></label>
        <input id="wr-width" type="range" min="560" max="980" step="20" value="${cfg.width}" />
      </section>`);
    const bind = (id, key, labelId) => {
      const el = document.getElementById(id);
      el.oninput = () => {
        cfg[key] = +el.value;
        document.getElementById(labelId).textContent = el.value;
        apply(cfg);
      };
    };
    bind("wr-size", "size", "wr-sz");
    bind("wr-height", "height", "wr-lh");
    bind("wr-width", "width", "wr-wd");
  });
})();
