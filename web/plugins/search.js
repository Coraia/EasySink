(() => {
  WR.on("read", ({ article, toolbar }) => {
    if (!toolbar || !article) return;
    const wrap = document.createElement("span");
    wrap.className = "search-wrap";
    wrap.innerHTML = `<input id="wr-find" type="search" placeholder="文内搜索" />`;
    toolbar.appendChild(wrap);
    const input = wrap.querySelector("input");
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = input.value.trim();
      if (!q) return;
      article.querySelectorAll("mark.wr-hit").forEach((m) => {
        m.replaceWith(document.createTextNode(m.textContent));
      });
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      let first = null;
      for (const node of nodes) {
        const text = node.textContent;
        if (!text || !re.test(text)) continue;
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        text.replace(re, (m, offset) => {
          if (offset > last) frag.appendChild(document.createTextNode(text.slice(last, offset)));
          const mark = document.createElement("mark");
          mark.className = "wr-hit";
          mark.textContent = m;
          if (!first) first = mark;
          frag.appendChild(mark);
          last = offset + m.length;
          return m;
        });
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        node.replaceWith(frag);
      }
      if (first) first.scrollIntoView({ block: "center" });
      else WR.toast("没有匹配");
    });
    window.WR._focusSearch = () => input.focus();
  });
})();
