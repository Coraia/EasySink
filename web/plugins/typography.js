import { $, e, local } from "../core.js";
export function install(ctx) {
  let prefs = local.get("typography", { size: 22, line: 1.95, width: 760 });
  const apply = () => {
    document.documentElement.style.setProperty(
      "--reading-size",
      prefs.size + "px",
    );
    document.documentElement.style.setProperty("--reading-line", prefs.line);
    document.documentElement.style.setProperty(
      "--reading-width",
      prefs.width + "px",
    );
  };
  apply();
  const read = ctx.hook("read", (r) =>
    r.tool("typography", "排版", () =>
      r.panel(
        "typography",
        "舒服地读",
        `${[
          ["size", "正文字号", 18, 30, 1, "px"],
          ["line", "行间距", 1.5, 2.6, 0.05, ""],
          ["width", "阅读栏宽", 560, 960, 20, "px"],
        ]
          .map(
            ([id, label, min, max, step, unit]) =>
              `<div class="gap"><label for="type-${id}">${label} <span id="type-value-${id}" class="meta">${prefs[id]}${unit}</span></label><input type="range" id="type-${id}" data-type="${id}" min="${min}" max="${max}" step="${step}" value="${prefs[id]}"></div>`,
          )
          .join(
            "",
          )}<p class="save-state gap" id="type-state">调整后自动保存到此浏览器</p><button id="reset-type">恢复默认排版</button>`,
        (el, scope) => {
          scope.on(el, "input", (ev) => {
            const input = ev.target.closest("[data-type]");
            if (!input) return;
            const anchor = r.position();
            prefs[input.dataset.type] = +input.value;
            apply();
            local.set("typography", prefs);
            $("#type-value-" + input.dataset.type, el).textContent =
              input.value;
            r.restore(anchor);
            $("#type-state", el).textContent = "已自动保存 ✓";
          });
          scope.on($("#reset-type", el), "click", () => {
            prefs = { size: 22, line: 1.95, width: 760 };
            apply();
            local.set("typography", prefs);
            r.closePanel();
          });
        },
      ),
    ),
  );
  return () => {
    read();
    ["--reading-size", "--reading-line", "--reading-width"].forEach((name) =>
      document.documentElement.style.removeProperty(name),
    );
  };
}
