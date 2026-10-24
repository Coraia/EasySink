import { $, e, api, local, busy, openDialog } from "./core.js";

const asset = "/static/assets/picturebook-lookdev-v2/";

export function mountShelfTabs(ctx, scope, selected, container) {
  const nav = document.createElement("nav");
  nav.className = "reading-shelf-tabs";
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "选择独立书架");
  nav.innerHTML = [["standard", "#/", "普通书架"], ["children", "#/children", "少儿书架"]]
    .map(([space, href, label]) => `<a id="shelf-tab-${space}" href="${href}" role="tab" aria-selected="${selected === space}" aria-controls="shelf-content" tabindex="${selected === space ? 0 : -1}">${label}${space === "children" ? '<small>PLUS</small>' : ""}</a>`).join("");
  // A real route per shelf; a book never receives an edition selector.
  container.prepend(nav);
  const content = document.createElement("section");
  content.id = "shelf-content";
  content.setAttribute("role", "tabpanel");
  content.setAttribute("aria-labelledby", `shelf-tab-${selected}`);
  while (nav.nextSibling) content.append(nav.nextSibling);
  container.append(content);
  scope.on(nav, "keydown", event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const standard = event.key === "Home" || event.key === "ArrowLeft";
    ctx.navigate(standard ? "#/" : "#/children");
  });
}
export function openChildrenPlan() {
  openDialog("给孩子自己的阅读小世界", `<div class="children-plan"><p>普通书架和少儿书架分别整理。孩子的故事与续读位置，留在少儿书架里。</p><div class="children-plan-status"><strong>少儿阅读 · 当前开放体验</strong><p>现有故事的完整章节、插画、词注和发音均可使用。</p></div><h3>少儿阅读计划</h3><p>我们计划将少儿阅读作为单独解锁的增值功能。价格和购买方式确定后，会在这里提供入口。</p><p class="muted">购买功能尚未开放；当前无需购买即可继续阅读。</p><button class="primary" id="children-plan-close">继续阅读</button></div>`, dialog => {
    $("#children-plan-close", dialog).onclick = () => dialog.close();
  });
}

export function installReadingSpaces(ctx) {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = new URL("./reading-spaces.css", import.meta.url).href;
  document.head.append(css);
  for (const route of ["living-book", "fox-story"]) ctx.route(route, async (scope, id) => {
    const { mountFoxReading } = await import("./picturebook-fox-reading.js");
    if (!scope.signal.aborted) await mountFoxReading(ctx, scope, id);
  });
  ctx.route("children", scope => mountChildrenShelf(ctx, scope));
}

async function mountChildrenShelf(ctx, scope) {
  const catalog = await api("/picturebook/shelf", { signal: scope.signal });
  if (scope.signal.aborted) return;
  document.body.classList.add("children-space");
  scope.cleanup(() => document.body.classList.remove("children-space"));
  const entries = catalog.books.map(book => {
    const remembered = local.get(`children-book-chapter:${book.book_id}`);
    const chapter = book.chapters.find(c => c.doc_id === remembered) || book.chapters[0];
    return { ...book, chapter };
  });
  const book = entries[0];
  ctx.root.innerHTML = `<main class="children-shelf"><header class="cs-header"><a class="cs-brand" href="#/children"><img class="easysink-brand-icon" src="/static/assets/brand/easysink-icon.svg" width="42" height="42" alt=""><span class="easysink-wordmark">EasySink<small>小小读者，大大世界。</small></span></a><button class="cs-parent" id="cs-parent">家长区 ↗</button></header><div id="cs-shelf"><div class="cs-welcome"><div><div class="cs-eyebrow">LITTLE READERS, BIG WORLDS</div><h1>今天，去故事里走走吧。</h1><p>一段英文，一幅画，一点点新的发现。</p></div><span class="cs-badge">少儿阅读 · 开放体验</span></div>${book ? `<section class="cs-continue" aria-label="少儿书架继续阅读"><div class="cs-continue-copy"><div class="cs-eyebrow">${book.chapter ? "我的星际旅程" : "从一个故事开始"}</div><h2>${e(book.title)}<small>${e(book.english_title)}</small></h2><p>${book.chapter ? `${e(book.chapter.title)}<br>继续上次的故事，遇见一点新的发现。` : "跟着小王子，看见大人看不见的世界。<br>完整英文、词语提示与发音，陪你慢慢读。"}</p><button class="primary" data-children-open="${e(book.catalog_id)}">${book.chapter ? "继续读故事" : "加入并开始阅读"} <span aria-hidden="true">→</span></button></div><div class="cs-art" aria-hidden="true"><img class="cs-meadow" src="${asset}meadow.png" alt=""><img class="cs-prince" src="${asset}prince.png" alt=""><img class="cs-fox" src="${asset}fox.png" alt=""><span>✧</span></div></section>` : ""}<div class="cs-section"><h2>${entries.some(b => b.chapter) ? "我的故事书" : "可以开始的故事"}</h2><span>${entries.length} 本故事书</span></div><div class="cs-books">${entries.map(b => `<button class="cs-book" data-children-open="${e(b.catalog_id)}"><div class="cs-cover" aria-hidden="true">THE LITTLE PRINCE<img src="${asset}prince.png" alt=""></div><div><h3>${e(b.title)}</h3><p>跟着小王子出发<br>${b.chapter_count} 章 · 插画与英文原文</p><span>${b.chapter ? "继续上次的旅程" : "加入少儿书架"}</span></div></button>`).join("")}<div class="cs-book cs-coming"><div class="cs-coming-star" aria-hidden="true">✧</div><div><h3>下一个故事，慢慢来。</h3><p>新的故事书正在准备中。</p><span>即将加入</span></div></div></div><footer class="cs-footer"><span>少儿书架 · 孩子自己的故事与阅读足迹</span><span>你的书籍和笔记留在普通书架</span></footer></div></main>`;
  mountShelfTabs(ctx, scope, "children", $("#cs-shelf", ctx.root));
  scope.on($("#cs-parent", ctx.root), "click", openChildrenPlan);
  scope.on(ctx.root, "click", event => {
    const button = event.target.closest("[data-children-open]");
    if (!button) return;
    const selected = entries.find(b => b.catalog_id === button.dataset.childrenOpen);
    if (!selected) return;
    busy(button, async () => {
      let docId = selected.chapter?.doc_id;
      if (!docId) {
        const installed = await api("/picturebook/little-prince/install", { method: "POST", signal: scope.signal });
        docId = installed.doc_id;
      }
      if (!scope.signal.aborted) ctx.navigate(`#/living-book/${docId}`);
    }, "正在打开故事…").catch(() => {});
  });
  // Restore keyboard orientation after a tab route, without selecting any book.
  if (document.activeElement === document.body) $("#shelf-tab-children", ctx.root)?.focus({ preventScroll: true });
}
