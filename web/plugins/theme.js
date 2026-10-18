import { $, local } from "../core.js";
export function install(ctx) {
  const apply = (theme) => (document.documentElement.dataset.theme = theme);
  apply(local.get("theme", "paper"));
  const profile = ctx.hook("profile", ({ scope }) => {
    const section = document.createElement("section");
    section.className = "card";
    section.innerHTML = `<h2>让眼睛舒服一点</h2><div class="chips" id="theme-choices">${[
      ["paper", "自然纸色"],
      ["sepia", "暖色书页"],
      ["night", "夜间阅读"],
    ]
      .map(
        ([v, label]) =>
          `<button class="chip" data-theme-choice="${v}" aria-pressed="${document.documentElement.dataset.theme === v}">${label}</button>`,
      )
      .join(
        "",
      )}</div><div class="save-state" id="theme-state">在此浏览器自动保存</div>`;
    $("#profile-extensions").append(section);
    scope.on(section, "click", (ev) => {
      const b = ev.target.closest("[data-theme-choice]");
      if (!b) return;
      apply(b.dataset.themeChoice);
      local.set("theme", b.dataset.themeChoice);
      section
        .querySelectorAll("button")
        .forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      $("#theme-state").textContent = "已自动保存 ✓";
    });
  });
  return () => {
    profile();
    apply("paper");
  };
}
