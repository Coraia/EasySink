export function install(ctx) {
  return ctx.hook("read", (reader) => {
    reader.tool("immersive", "回到专注", () => {
      reader.closePanel();
      reader.focus.close();
    });
  });
}
