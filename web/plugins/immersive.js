(() => {
  const KEY = "wr.immersive";

  function apply(on) {
    document.body.classList.toggle("immersive", on);
    localStorage.setItem(KEY, on ? "1" : "0");
    let exit = document.getElementById("wr-imm-exit");
    if (on && !exit) {
      exit = document.createElement("button");
      exit.id = "wr-imm-exit";
      exit.className = "imm-exit";
      exit.textContent = "退出沉浸";
      exit.onclick = () => apply(false);
      document.body.appendChild(exit);
    }
    if (!on && exit) exit.remove();
  }

  if (localStorage.getItem(KEY) === "1") apply(true);

  WR.on("read", ({ toolbar }) => {
    if (!toolbar) return;
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = "沉浸";
    b.onclick = () => apply(!document.body.classList.contains("immersive"));
    toolbar.appendChild(b);
  });

  window.WR._immersiveToggle = () => apply(!document.body.classList.contains("immersive"));
})();
