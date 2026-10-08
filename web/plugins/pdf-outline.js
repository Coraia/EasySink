import { $, e, api, local, toast } from "../core.js";
import { resolveOutlineTarget, readingAnchorForTarget } from "./pdf-outline-target.js?v=20261008-outline";

// Outline data is requested only from the explicit directory action. Destinations
// stay unresolved until clicked; opening a book never walks the PDF page tree.
// Unknown/external destinations cannot become a default page-one navigation.
const PAGE_WINDOW = 50;
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 32;

export class PDFOutline {
  constructor(controller, loadPDF) {
    this.controller = controller;
    this.r = controller.r;
    this.loadPDF = loadPDF;
    this.book = this.r.doc.pdf.book_id;
    this.sha = this.r.doc.pdf.source_sha256;
    this.sequence = 0;
  }
  current(scope, sequence) {
    return !scope.signal.aborted && !this.r.scope.signal.aborted &&
      this.r.ctx.reader === this.r && this.r.doc.pdf?.book_id === this.book &&
      this.r.doc.pdf?.source_sha256 === this.sha &&
      (sequence == null || sequence === this.sequence);
  }
  async tree() {
    if (!this.treePromise) {
      this.treePromise = (async () => {
        const pdf = await this.loadPDF();
        if (pdf.numPages !== this.r.doc.pdf.page_count)
          throw new Error("原件页数与书籍记录不一致，章节目标尚不能确认。");
        const tree = await pdf.getOutline();
        if (tree != null && !Array.isArray(tree))
          throw new Error("原书章节目录格式无法识别。");
        return tree || [];
      })().catch(error => { this.treePromise = null; throw error; });
    }
    return this.treePromise;
  }
  open() {
    return this.r.panel("outline", "原书目录",
      '<p class="pdf-outline-status meta" role="status">正在读取原书章节目录…</p><div class="pdf-outline-content"></div>',
      async (el, scope) => {
        const state = $(".pdf-outline-status", el);
        const content = $(".pdf-outline-content", el);
        let entries = [], pageStart = 1;
        const currentPage = this.r.position()?.pdf_source?.page_number || this.r.doc.pdf.start_page;
        const draw = async () => {
          state.textContent = "正在读取原书章节目录…";
          try {
            const tree = await this.tree();
            if (!this.current(scope)) return;
            entries = [];
            let limited = false;
            const list = (items, depth = 0) => {
              if (depth > MAX_DEPTH) { limited = true; return ""; }
              let html = '<ol class="pdf-outline-list">';
              for (const item of items) {
                if (entries.length >= MAX_ENTRIES) { limited = true; break; }
                if (!item || typeof item !== "object") continue;
                const id = entries.length;
                entries.push(item);
                const title = typeof item.title === "string" && item.title.trim()
                  ? item.title.slice(0, 2048) : "未命名书签";
                const external = !!(item.url || item.unsafeUrl || item.action);
                const disabled = external || !item.dest;
                const hint = external ? "外部目标" : !item.dest ? "目标未提供" : "";
                html += `<li class="pdf-outline-node"><button type="button" class="toc-link pdf-outline-entry" data-pdf-outline-entry="${id}" ${disabled ? "disabled" : ""}>${e(title)}${hint ? `<small class="pdf-outline-hint"> · ${hint}</small>` : ""}</button>`;
                if (Array.isArray(item.items) && item.items.length) html += list(item.items, depth + 1);
                html += "</li>";
              }
              return html + "</ol>";
            };
            if (tree.length) {
              const html = list(tree);
              state.textContent = `原书章节层级 · 当前 PDF 原页 ${currentPage}`;
              content.innerHTML = `<nav class="pdf-outline-tree" aria-label="原书章节">${html}</nav>${limited ? '<p class="muted">原书目录过长，后续位置可通过原页目录访问。</p>' : ""}<button type="button" class="text-button" data-pdf-page-directory>按原页查找</button>`;
              return;
            }
            showPages("原书未提供章节书签，以下按 PDF 原页排列。");
          } catch (error) {
            if (!this.current(scope) || error.name === "AbortError") return;
            showPages(`章节目录暂未读到：${error.message} 仍可按原页查找。`, true);
          }
        };
        const showPages = (message = "按 PDF 原页查找。", retry = false) => {
          content.removeAttribute("aria-busy");
          state.textContent = message;
          pageStart = Math.floor((currentPage - 1) / PAGE_WINDOW) * PAGE_WINDOW + 1;
          content.innerHTML = `<section class="pdf-page-directory" aria-label="原页目录"><h3>原页目录</h3><form class="pdf-outline-page-form row"><label>PDF 原页 <input type="number" min="1" max="${this.r.doc.pdf.page_count}" value="${currentPage}" aria-label="目录原页页码" required></label><button type="submit">前往</button></form><div data-pdf-page-list></div><div class="row"><button type="button" data-pdf-page-window="-1">前 50 原页</button><span class="meta" data-pdf-page-window-label></span><button type="button" data-pdf-page-window="1">后 50 原页</button></div>${entries.length ? '<button type="button" class="text-button" data-pdf-outline-back>返回原书章节</button>' : ""}${retry ? '<button type="button" class="text-button" data-pdf-outline-retry>重试章节目录</button>' : ""}</section>`;
          drawPages();
        };
        const drawPages = () => {
          content.removeAttribute("aria-busy");
          const end = Math.min(pageStart + PAGE_WINDOW - 1, this.r.doc.pdf.page_count);
          $("[data-pdf-page-list]", content).innerHTML = Array.from({length: end - pageStart + 1}, (_, i) => {
            const page = pageStart + i;
            return `<button type="button" class="toc-link pdf-outline-page ${page === currentPage ? "active" : ""}" data-pdf-source-page="${page}" ${page === currentPage ? 'aria-current="page"' : ""}>PDF 原页 ${page}</button>`;
          }).join("");
          $("[data-pdf-page-window-label]", content).textContent = `${pageStart}–${end} / ${this.r.doc.pdf.page_count}`;
          $('[data-pdf-page-window="-1"]', content).disabled = pageStart <= 1;
          $('[data-pdf-page-window="1"]', content).disabled = end >= this.r.doc.pdf.page_count;
        };
        const choose = async (entry, page) => {
          const sequence = ++this.sequence;
          state.textContent = "正在定位原书位置…";
          content.setAttribute("aria-busy", "true");
          try {
            const target = entry
              ? await resolveOutlineTarget(await this.loadPDF(), entry, this.r.doc.pdf)
              : this.pageTarget(page);
            if (!this.current(scope, sequence)) return;
            await this.jump(target, entry?.title || "", scope, sequence);
          } catch (error) {
            if (this.current(scope, sequence) && error.name !== "AbortError")
              state.textContent = error.message || "这个目录位置暂不能打开。";
          } finally {
            if (this.current(scope, sequence)) content.removeAttribute("aria-busy");
          }
        };
        scope.on(content, "click", event => {
          const button = event.target.closest("button");
          if (!button || button.disabled) return;
          // A newer choice invalidates any older PDF worker response.
          this.sequence++;
          if (button.hasAttribute("data-pdf-outline-entry"))
            void choose(entries[Number(button.dataset.pdfOutlineEntry)]);
          else if (button.hasAttribute("data-pdf-source-page"))
            void choose(null, Number(button.dataset.pdfSourcePage));
          else if (button.hasAttribute("data-pdf-page-directory")) showPages();
          else if (button.hasAttribute("data-pdf-page-window")) {
            pageStart += Number(button.dataset.pdfPageWindow) * PAGE_WINDOW;
            drawPages();
          } else if (button.hasAttribute("data-pdf-outline-back") || button.hasAttribute("data-pdf-outline-retry")) void draw();
        });
        scope.on(content, "submit", event => {
          if (!event.target.matches(".pdf-outline-page-form")) return;
          event.preventDefault();
          void choose(null, Number($("input", event.target).value));
        });
        await draw();
      });
  }
  pageTarget(page) {
    if (!Number.isInteger(page) || page < 1 || page > this.r.doc.pdf.page_count)
      throw new Error("请选择原件范围内的 PDF 原页。");
    return {page_number: page, kind: "page", x: null, y: null,
      source: {page_number: page, book_id: this.book, source_sha256: this.sha}};
  }
  async jump(target, title, scope, sequence) {
    const status = await api(`/pdf/books/${this.book}`, {signal: scope.signal});
    if (!this.current(scope, sequence)) return;
    if (status.pdf?.source_sha256 !== this.sha || status.pdf?.book_id !== this.book)
      throw new Error("书籍原件身份发生变化，请重新打开目录。");
    const range = status.pdf.ranges?.find(range =>
      range.start_page <= target.page_number && target.page_number <= range.end_page);
    let doc = null;
    if (range) {
      doc = range.doc_id === this.r.doc.id ? this.r.doc
        : await api(`/documents/${range.doc_id}?compact=true`, {signal: scope.signal});
      if (!this.current(scope, sequence)) return;
      if (doc.pdf?.book_id !== this.book || doc.pdf?.source_sha256 !== this.sha)
        throw new Error("目标阅读内容与原件不一致，未跳转。");
    }
    const anchor = doc && readingAnchorForTarget(doc, target, title);
    if (!anchor) {
      this.controller.openOriginal(target.source);
      toast(`此处阅读版尚不能可靠定位，已打开 PDF 原页 ${target.page_number}。`);
      return;
    }
    if (doc.id === this.r.doc.id) {
      this.r.closePanel();
      await this.r.restore(anchor);
    } else {
      // Use the Reader's existing one-use jump contract, preserving its resume
      // ordering and PDF source checks; don't navigate if persistence failed.
      if (!local.set(`jump:${doc.id}`, anchor)) return;
      this.r.ctx.navigate(`#/read/${doc.id}`);
    }
  }
}
