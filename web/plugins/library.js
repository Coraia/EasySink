import { e, api, local } from "../core.js";
import { pdfImportProgress, watchPDFImport } from "./pdf-import-progress.js";

function isPDF(book) {
  return book.source === "pdf" || !!book.pdf;
}
function readingDocument(id) {
  if (typeof id !== "number" && typeof id !== "string") return null;
  const value = Number(id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function pdfChapters(book) {
  return (Array.isArray(book.chapters) ? book.chapters : []).filter(
    (chapter) =>
      chapter.ready !== false &&
      chapter.reading_ready !== false &&
      readingDocument(chapter.doc_id) !== null,
  );
}
function pdfReadingDocument(book, remembered) {
  if (book.pdf?.lifecycle === "recycled")
    return { docId: null, continued: false };
  const chapters = pdfChapters(book);
  const first =
    book.pdf && Object.hasOwn(book.pdf, "reading_doc_id")
      ? readingDocument(book.pdf.reading_doc_id)
      : (readingDocument(book.reading_doc_id) ??
        readingDocument(chapters[0]?.doc_id));
  const previous = readingDocument(remembered);
  const validPrevious =
    previous !== null &&
    (previous === first ||
      chapters.some((chapter) => readingDocument(chapter.doc_id) === previous));
  return { docId: validPrevious ? previous : first, continued: validPrevious };
}
function pdfBookId(book) {
  return book.pdf?.book_id ?? book.book_id ?? book.id;
}
function pdfSubtitle(book) {
  const pageCount = book.pdf?.page_count;
  const count = pdfChapters(book).length;
  const hasReading = pdfReadingDocument(book).docId !== null;
  return [
    Number.isInteger(pageCount) && pageCount > 0
      ? `${pageCount} 原页`
      : "PDF 原件已登记",
    count
      ? `${count} 个可读原页范围`
      : hasReading
        ? "已有可读原页范围"
        : "阅读版待准备",
    book.author,
  ]
    .filter(Boolean)
    .join(" · ");
}
function pdfChapterTitle(chapter) {
  const start = chapter.pdf?.start_page ?? chapter.start_page;
  const end = chapter.pdf?.end_page ?? chapter.end_page;
  if (
    Number.isInteger(start) &&
    start > 0 &&
    Number.isInteger(end) &&
    end >= start
  )
    return `原页 ${start}${end === start ? "" : `–${end}`}`;
  return /原页/.test(chapter.title || "")
    ? chapter.title
    : `原页范围 · ${chapter.title || "阅读内容"}`;
}

export function install(ctx) {
  const read = ctx.hook("read", async (reader) => {
    const { doc, scope } = reader;
    if (!doc.chapter || doc.pdf) return;
    const book = await api(`/library/books/${doc.chapter.book_id}`, { signal: scope.signal });
    if (scope.signal.aborted) return;
    reader.book = book;
    const chapter = `第 ${doc.chapter.idx + 1} / ${doc.chapters.length} 章`;
    const label = `${book.title} · ${chapter} · ${doc.title}`;
    const root = ctx.root.querySelector(".reader");
    root.dataset.bookId = String(book.id);
    root.dataset.bookTitle = book.title;
    for (const element of root.querySelectorAll(".banner-title, .caption-title")) {
      element.textContent = label;
      element.title = label;
    }
  });
  const home = ctx.hook("home", async (view) => {
    const [bookResponse, recycleResponse] = await Promise.allSettled([
      api("/library/books", { signal: view.scope.signal }),
      api("/pdf/recycle", { signal: view.scope.signal }),
    ]);
    if (view.scope.signal.aborted) return;
    if (bookResponse.status === "rejected") throw bookResponse.reason;
    const books = bookResponse.value;
    const recycledBooks =
      recycleResponse.status === "fulfilled" &&
      Array.isArray(recycleResponse.value?.books) &&
      recycleResponse.value.books.every(
        (book) =>
          book &&
          pdfBookId(book) != null &&
          Array.isArray(book.chapters) &&
          book.chapters.every(
            (chapter) => chapter && readingDocument(chapter.doc_id) !== null,
          ),
      )
        ? recycleResponse.value.books
        : null;
    view.pdfRecycleUnavailable = recycledBooks === null;
    const knownRecycled = books.filter(
      (book) => isPDF(book) && book.pdf?.lifecycle === "recycled",
    );
    if (recycledBooks) knownRecycled.push(...recycledBooks);
    const recycledBookIds = new Set(
      knownRecycled.map((book) => String(pdfBookId(book))),
    );
    const recycledDocumentIds = new Set();
    for (const book of knownRecycled) {
      for (const chapter of book.chapters || []) {
        const docId = readingDocument(chapter.doc_id);
        if (docId !== null) recycledDocumentIds.add(docId);
      }
      const readingId = readingDocument(book.pdf?.reading_doc_id);
      if (readingId !== null) recycledDocumentIds.add(readingId);
    }
    // Home's archived filter uses the original documents array, so preserve its
    // identity while hiding retained ranges belonging to known recycled PDFs.
    for (let index = view.documents.length - 1; index >= 0; index--) {
      if (recycledDocumentIds.has(readingDocument(view.documents[index].id)))
        view.documents.splice(index, 1);
    }
    const activeBooks = books.filter(
      (book) => !isPDF(book) || !recycledBookIds.has(String(pdfBookId(book))),
    );
    view.collections = activeBooks.map((b) => {
      const remembered =
        ctx.enabled("progress") && local.get(`book-chapter:${b.id}`);
      if (isPDF(b)) {
        const { docId, continued } = pdfReadingDocument(b, remembered);
        const card = {
          ...b,
          cardKey: `pdf-${pdfBookId(b)}`,
          statusHref: `#/pdf-status/${encodeURIComponent(pdfBookId(b))}`,
          coverLabel: "WISE READER / PDF",
          subtitle: pdfSubtitle(b),
          href: docId
            ? `#/read/${docId}`
            : `#/pdf/${encodeURIComponent(pdfBookId(b))}`,
          action: continued ? "继续阅读" : docId ? "打开阅读" : "查看准备状态",
        };
        watchPDFImport(b, view.scope, (next, state) => {
          const reading = pdfReadingDocument(next, remembered);
          Object.assign(card, {
            pdf: next.pdf,
            chapters: next.chapters,
            subtitle: pdfSubtitle(next),
            href: reading.docId ? `#/read/${reading.docId}` : `#/pdf/${encodeURIComponent(pdfBookId(next))}`,
            action: reading.continued ? "继续阅读" : reading.docId ? "开始阅读" : "查看准备状态",
            statusHTML: pdfImportProgress(next, state),
          });
          // Patch only this card. Preserve search, scroll, keyboard focus and
          // the collection model used when filters render the grid again.
          const node = ctx.root.querySelector(`[data-card-key="${card.cardKey}"]`);
          if (!node) return;
          node.querySelector("[data-card-open]").href = card.href;
          node.querySelector("[data-card-subtitle]").textContent = card.subtitle;
          node.querySelector("[data-card-action]").textContent = card.action;
          const status = node.querySelector("[data-card-status]");
          if (status.innerHTML !== card.statusHTML) status.innerHTML = card.statusHTML;
        });
        return card;
      }
      const chapter =
        b.chapters.find((ch) => ch.doc_id === remembered) || b.chapters[0];
      const continued = chapter?.doc_id === remembered;
      return {
        ...b,
        coverLabel: "WISE READER / " + b.source.toUpperCase(),
        subtitle: `${b.chapter_count} 章 · ${b.author || "已导入"}`,
        readingChapter: chapter ? `${continued ? "续读" : "从"}第 ${chapter.idx + 1} 章 · ${chapter.title}` : "",
        href: chapter ? `#/read/${chapter.doc_id}` : `#/book/${b.id}`,
        action: continued ? "继续阅读" : "打开阅读",
      };
    });
    view.chapterIds = new Set(
      books.flatMap((b) => {
        if (!isPDF(b)) return b.chapters.map((ch) => ch.doc_id);
        // Even an unavailable PDF range belongs to this book, not a second card.
        const ids = (Array.isArray(b.chapters) ? b.chapters : [])
          .map((ch) => readingDocument(ch.doc_id))
          .filter((id) => id !== null);
        const readingId = pdfReadingDocument(b).docId;
        if (readingId !== null) ids.push(readingId);
        return ids;
      }),
    );
    for (const docId of recycledDocumentIds) view.chapterIds.add(docId);
  });
  const route = ctx.route("book", async (scope, id) => {
    const b = await api("/library/books/" + id, { signal: scope.signal });
    if (scope.signal.aborted) return;
    if (isPDF(b)) {
      if (b.pdf?.lifecycle === "recycled") {
        ctx.navigate(`#/pdf/${encodeURIComponent(pdfBookId(b))}`);
        return;
      }
      const chapters = pdfChapters(b);
      const readingId = pdfReadingDocument(b).docId;
      const content = chapters
        .map(
          (ch, index) =>
            `<a class="list-item row between" href="#/read/${readingDocument(ch.doc_id)}"><div><span class="meta">范围 ${String(index + 1).padStart(2, "0")}</span>　${e(pdfChapterTitle(ch))}</div><span class="meta">${Number(ch.word_count || 0).toLocaleString()} 词 →</span></a>`,
        )
        .join("");
      ctx.root.innerHTML = `<div class="page"><div class="page-head"><div><div class="eyebrow">PDF · 原页范围</div><h1>${e(b.title)}</h1><p>${e(pdfSubtitle(b))}</p></div><a class="button" href="#/">← 书架</a></div><section class="card">${content || (readingId ? `<a class="list-item" href="#/read/${readingId}">打开已就绪原页范围 →</a>` : '<p class="muted">原件已保存在书架，阅读版尚未就绪。</p>')}<a class="list-item" href="#/pdf/${e(encodeURIComponent(pdfBookId(b)))}">原版与转换状态 →</a></section></div>`;
      return;
    }
    ctx.root.innerHTML = `<div class="page"><div class="page-head"><div><div class="eyebrow">${e(b.source.toUpperCase())} · ${b.chapters.length} CHAPTERS</div><h1>${e(b.title)}</h1><p>${e(b.author || "我的书籍")}</p></div><a class="button" href="#/">← 书架</a></div><section class="card">${b.chapters.map((ch) => `<a class="list-item row between" href="#/read/${ch.doc_id}"><div><span class="meta">${String(ch.idx + 1).padStart(2, "0")}</span>　${e(ch.title)}</div><span class="meta">${ch.word_count.toLocaleString()} 词 →</span></a>`).join("") || '<p class="muted">这本书还没有章节。</p>'}</section></div>`;
  });
  return () => {
    read();
    home();
    route();
  };
}
