(() => {
  WR.on("read", ({ article, toolbar }) => {
    if (!toolbar || !article) return;
    const b = document.createElement("button");
    b.className = "ghost";
    b.textContent = "朗读";
    b.onclick = () => {
      if (!window.speechSynthesis) return WR.toast("浏览器不支持朗读");
      if (speechSynthesis.speaking) {
        speechSynthesis.cancel();
        b.textContent = "朗读";
        return;
      }
      const u = new SpeechSynthesisUtterance(article.innerText);
      u.lang = "en-US";
      u.onend = () => { b.textContent = "朗读"; };
      speechSynthesis.speak(u);
      b.textContent = "停止";
    };
    toolbar.appendChild(b);
  });
  window.addEventListener("hashchange", () => {
    if (window.speechSynthesis) speechSynthesis.cancel();
  });
})();
