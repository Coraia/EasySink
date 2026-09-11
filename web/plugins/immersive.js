export function install(ctx) {
  return ctx.hook("read", (reader) => {
    const b = reader.tool("immersive", "专注", () => {
      const active = document.body.classList.toggle("immersive");
      b.textContent = active ? "退出专注" : "专注";
      b.setAttribute("aria-pressed", String(active));
    });
    reader.scope.cleanup(() => document.body.classList.remove("immersive"));
  });
}
