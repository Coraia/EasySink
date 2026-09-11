import { $, escapeEditing } from "../core.js";
export function install(ctx) {
  return ctx.hook("read", (r) =>
    r.scope.on(document, "keydown", (ev) => {
      if (escapeEditing(ev)) return;
      if (ev.key === "Escape") {
        r.closePop();
        if (r.panelId) r.closePanel();
        else if (document.body.classList.contains("immersive"))
          $("#tool-immersive")?.click();
        return;
      }
      const tools = {
        f: "immersive",
        "/": "search",
        n: "notes",
        b: "bookmarks",
      };
      const tool = tools[ev.key.toLowerCase()];
      if (tool) {
        ev.preventDefault();
        $("#tool-" + tool)?.click();
      }
      if (ev.key === "[" || ev.key === "]") {
        ev.preventDefault();
        const levels = [0, 2, 4, 8],
          index = levels.indexOf(r.doc.density),
          next = Math.max(0, Math.min(3, index + (ev.key === "[" ? -1 : 1)));
        r.density(levels[next]);
      }
    }),
  );
}
