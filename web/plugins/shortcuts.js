(() => {
  WR.on("read", () => {
    if (WR._shortcutHinted) return;
    WR._shortcutHinted = true;
    WR.toast("快捷键：F 沉浸 · / 搜索 · [ ] 密度 · Esc 退出");
  });

  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) {
      if (e.key === "Escape") e.target.blur();
      return;
    }
    const onRead = location.hash.startsWith("#/read/");
    if (e.key === "Escape") {
      document.body.classList.remove("immersive");
      const exit = document.getElementById("wr-imm-exit");
      if (exit) exit.click();
      return;
    }
    if (!onRead) return;
    if (e.key === "f" || e.key === "F") {
      if (WR._immersiveToggle) WR._immersiveToggle();
    } else if (e.key === "/") {
      e.preventDefault();
      if (WR._focusSearch) WR._focusSearch();
    } else if (e.key === "[" || e.key === "]") {
      const dens = document.getElementById("dens");
      if (!dens) return;
      const step = e.key === "]" ? 0.5 : -0.5;
      dens.value = String(Math.min(10, Math.max(1, +dens.value + step)));
      dens.dispatchEvent(new Event("input"));
      dens.dispatchEvent(new Event("change"));
    }
  });
})();
