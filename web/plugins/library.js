import { $, e, api, toast } from "../core.js";
export function install(ctx) {
  const home = ctx.hook("home", async (view) => {
    const books = await api("/library/books", { signal: view.scope.signal });
    if (view.scope.signal.aborted) return;
    view.collections = books.map((b) => ({
      ...b,
      coverLabel: "WISE READER / " + b.source.toUpperCase(),
      subtitle: `${b.chapter_count} 章 · ${b.author || "已导入"}`,
      href: `#/book/${b.id}`,
      action: "查看章节",
    }));
    view.chapterIds = new Set(
      books.flatMap((b) => b.chapters.map((ch) => ch.doc_id)),
    );
  });
  const route = ctx.route("book", async (scope, id) => {
    const b = await api("/library/books/" + id, { signal: scope.signal });
    if (scope.signal.aborted) return;
    ctx.root.innerHTML = `<div class="page"><div class="page-head"><div><div class="eyebrow">${e(b.source.toUpperCase())} · ${b.chapters.length} CHAPTERS</div><h1>${e(b.title)}</h1><p>${e(b.author || "我的书籍")}</p></div><a class="button" href="#/">← 书架</a></div><section class="card">${b.chapters.map((ch) => `<a class="list-item row between" href="#/read/${ch.doc_id}"><div><span class="meta">${String(ch.idx + 1).padStart(2, "0")}</span>　${e(ch.title)}</div><span class="meta">${ch.word_count.toLocaleString()} 词 →</span></a>`).join("") || '<p class="muted">这本书还没有章节。</p>'}</section>${ctx.enabled("translate") ? '<button class="gap" id="translate-book">翻译整本书 →</button>' : ""}</div>`;
    scope.on($("#translate-book"), "click", async (ev) => {
      ev.target.disabled = true;
      try {
        await api("/translate/books/" + id, { method: "POST" });
        ctx.navigate("#/jobs");
      } catch (err) {
        toast(err.message);
        ev.target.disabled = false;
      }
    });
  });
  return () => {
    home();
    route();
  };
}
