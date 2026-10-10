import { $, e, api, local } from "./core.js";
import { sourceUrlRanges, overlapsSourceUrl, sourceUrlParts } from "./source-urls.js";
import { pdfInlineStyles, pdfInlineObjects, renderPdfInline } from "./pdf-inline.js";

import { PageCurlRenderer } from "./page-curl-renderer.js?v=20261008-paper";

import { installReadingEdgeDrag } from "./reading-edge-drag.js?v=20261007-native-hd";

// Page numbers are presentation only. Every fragment keeps source UTF-16 offsets.
export class ReadingPages {
  constructor(reader) {
    this.r = reader;
    this.pages = [];
    this.index = 0;
    this.anchor = null;
    this.width = 0;
    this.height = 0;
    this.count = 1;
    this.animating = false;
    this.painter = reader.handoff?.painter || new PageCurlRenderer(this);
    if (reader.handoff?.painter) this.painter.rebind(this);
    this.generation = 0;
    this.navigation = 0;
    this.waiters = [];
    this.complete = true;
    this.ranges = new Map();
    this.edge = installReadingEdgeDrag(this);
    this.measure = document.createElement("article");
    this.measure.className = "reading-prose reading-page-measure";
    this.measure.setAttribute("aria-hidden", "true");
    document.querySelector(".reader").append(this.measure);
    const scope = reader.scope;
    scope.on($("#article"), "pointerdown", () => {
      // A slow boundary load must not steal a new word lookup or text selection.
      if (this.preview?.boundary) this.finishAnimation("range-interrupted");
    }, {capture: true});
    let pixelRatio = devicePixelRatio || 1;
    scope.on(window, "resize", () => {
      if (pixelRatio === (devicePixelRatio || 1)) return;
      pixelRatio = devicePixelRatio || 1;
      this.invalidatePaint();
    });
    scope.cleanup(() => {
      this.finishAnimation("route-leave");
      this.clearRanges();
      ++this.generation;
      ++this.navigation;
      clearTimeout(this.timer);
      this.wake();
      this.measure.remove();
    });
    let timer;
    const resize = new ResizeObserver(() => {
      if (reader.scope.signal.aborted) return;
      const rect = $(".reading-columns")?.getBoundingClientRect();
      if (!rect || !this.layoutChanged(rect)) return;
      clearTimeout(timer);
      timer = setTimeout(() => this.reflow(this.position()), 100);
    });
    resize.observe($(".reading-columns"));
    resize.observe($("#article"));
    scope.cleanup(() => {
      resize.disconnect();
      clearTimeout(timer);
    });
  }
  layoutChanged(rect) {
    const article = $("#article").getBoundingClientRect();
    return (
      Math.abs(rect.width - (this.containerWidth || 0)) > 1 ||
      Math.abs(rect.height - (this.containerHeight || 0)) > 1 ||
      Math.abs(article.width - (this.articleWidth || 0)) > 1 ||
      Math.abs(article.height - (this.articleHeight || 0)) > 1
    );
  }
  layout() {
    const article = $("#article"),
      box = $(".reading-columns").getBoundingClientRect();
    const translated = !$("#translation-pane").hidden;
    const prefs = local.get("page-layout", "auto");
    const size =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--reading-size",
        ),
      ) || 22;
    const minimum = prefs === "double" ? 1000 : 2 * (size * 21 + 48) + 8;
    this.count =
      !translated && prefs !== "single" && box.width >= minimum ? 2 : 1;
    article.dataset.layout = this.count === 2 ? "double" : "single";
    $(".reader").dataset.pageLayout = article.dataset.layout;
    if (!article.children.length) article.innerHTML = this.leafMarkup(0);
    const leaf = article.querySelector(".page-leaf"),
      rect = leaf.getBoundingClientRect(),
      css = getComputedStyle(leaf);
    this.containerWidth = box.width;
    this.containerHeight = box.height;
    const articleBox = article.getBoundingClientRect();
    this.articleWidth = articleBox.width;
    this.articleHeight = articleBox.height;
    this.width = rect.width;
    this.height = Math.max(
      72,
      articleBox.height -
        parseFloat(css.paddingTop) -
        parseFloat(css.paddingBottom) -
        48 -
        4,
    );
    this.measure.style.width =
      Math.max(
        80,
        rect.width -
          parseFloat(css.paddingLeft) -
          parseFloat(css.paddingRight) -
          24 -
          2,
      ) + "px";
  }
  leafMarkup(index) {
    const fragments = this.pages[index] || [];
    return `<section class="page-leaf" data-page-index="${index}"><div class="leaf-heading">${e(this.r.doc.title)}</div><div class="reading-prose">${fragments.map((f) => this.markup(f)).join("")}</div></section>`;
  }
  invalidatePaint() {
    this.finishAnimation();
    this.painter.invalidate();
    this.painter.warm();
  }
  finishAnimation(reason = "cancelled") {
    this.edge?.cancel(reason);
    this.trackpad?.cancel(reason);
    if (this.preview) {
      const preview = this.preview;
      this.preview = null;
      preview.cancelled = true;
      cancelAnimationFrame(preview.raf);
      clearTimeout(preview.timeout);
      clearTimeout(preview.confirmTimer);
      clearTimeout(preview.loadingTimer);
      this.painter.record(false, reason, preview.requested, undefined, preview.setup);
      if (preview.boundary) this.recordBoundary(preview, false, reason);
    }
    delete $(".reader")?.dataset.pageTurning;
    clearTimeout(this.animationTimeout);
    this.animationToken = (this.animationToken || 0) + 1;
    this.painter.finish();
    this.animating = false;
  }
  adjacent(direction) {
    if (this.r.focus.isOpen() || this.animating || this.displayPending) return;
    const target = this.index + direction * this.count;
    if (target < 0 || (this.complete && target >= this.pages.length)) {
      const next = this.neighbor(direction);
      if (next) {
        const rect = $("#article").getBoundingClientRect();
        this.beginTurn(direction, rect.top + rect.height * 0.68, true)?.release(true, "tap");
      } else this.r.status(this.r.doc.chapter
        ? direction > 0 ? "已到全书末尾" : "已到全书开头"
        : direction > 0 ? "已到本篇末尾" : "已到本篇开头");
      return;
    }
    return this.turn(Math.max(0, target), true);
  }
  neighbor(direction) {
    const chapters = this.r.doc.chapters || [];
    const current = chapters.findIndex(ch => ch.doc_id === this.r.doc.id);
    return this.r.doc.chapter && current >= 0 ? chapters[current + direction] : null;
  }
  rangeNeighbor(direction, report = false) {
    const doc = this.r.doc, next = this.neighbor(direction);
    if (!next) return null;
    // EPUB chapters use the same prepared-paper handoff. A plain route would
    // restore the destination's old resume position and drop the turn animation.
    if (!doc.pdf) return next;
    const range = doc.pdf.ranges?.find(v => v.doc_id === next.doc_id);
    if (!range || (direction > 0 ? range.start_page !== doc.pdf.end_page + 1
      : range.end_page !== doc.pdf.start_page - 1)) {
      if (report) this.r.status("相邻原页范围尚未准备，可从目录选择已准备内容或核对原版。", {notice: true});
      return null;
    }
    return next;
  }
  clearRanges() {
    clearTimeout(this.rangeWarmTimer);
    for (const entry of this.ranges.values()) entry.controller.abort();
    this.ranges.clear();
  }
  warmRanges() {
    clearTimeout(this.rangeWarmTimer);
    if (!this.r.doc.chapter || !this.complete || this.displayPending) return;
    const directions = [];
    if (this.index < this.count * 2) directions.push(-1);
    if (this.index + this.count * 2 >= this.pages.length) directions.push(1);
    this.rangeWarmTimer = setTimeout(async () => {
      for (const direction of directions) {
        if (this.r.scope.signal.aborted || this.animating) return;
        if (this.rangeNeighbor(direction)) {
          try {
            const source = await this.prepareRange(direction);
            if (!this.animating && !this.r.scope.signal.aborted)
              await this.painter.prepare(source.index + (direction < 0 ? this.count - 1 : 0), source);
          } catch { /* Retry on the actual turn. */ }
        }
      }
    }, 160);
  }
  prepareRange(direction) {
    const next = this.rangeNeighbor(direction);
    if (!next) return Promise.reject(new Error("相邻阅读内容尚未准备"));
    if (this.ranges.has(next.doc_id)) return this.ranges.get(next.doc_id).promise;
    const controller = new AbortController(), generation = this.generation;
    const entry = {controller, packet: null};
    this.ranges.set(next.doc_id, entry);
    const timeout = setTimeout(() => controller.abort(), 15000);
    entry.promise = (async () => {
      let measure;
      try {
        const doc = await api(`/documents/${next.doc_id}?compact=true&density=${this.r.doc.density}`, {signal: controller.signal});
        if (this.r.doc.pdf ? (!doc.pdf || doc.pdf.book_id !== this.r.doc.pdf.book_id ||
            doc.pdf.source_sha256 !== this.r.doc.pdf.source_sha256 ||
            (direction > 0 ? doc.pdf.start_page !== this.r.doc.pdf.end_page + 1
              : doc.pdf.end_page !== this.r.doc.pdf.start_page - 1))
            : (!doc.chapter || doc.pdf || doc.chapter.book_id !== this.r.doc.chapter.book_id ||
              doc.chapter.idx !== this.r.doc.chapter.idx + direction || doc.id !== next.doc_id))
          throw new Error("相邻阅读内容已更新，请从目录重新核对阅读位置");
        // A bounded neighboring range, not a second mounted reader or a whole book.
        const reader = Object.create(Object.getPrototypeOf(this.r));
        Object.assign(reader, {ctx: this.r.ctx, scope: this.r.scope, doc, search: ""});
        const pages = Object.create(ReadingPages.prototype);
        measure = this.measure.cloneNode(false);
        this.measure.parentElement.append(measure);
        Object.assign(pages, {r: reader, measure, pages: [], index: 0,
          width: this.width, height: this.height, count: this.count, generation});
        reader.pages = pages;
        pages.indexSource();
        const builder = pages.buildPages();
        let done = false;
        while (!done) {
          controller.signal.throwIfAborted();
          if (this.r.scope.signal.aborted || generation !== this.generation)
            throw new DOMException("Reading layout changed", "AbortError");
          // Measurement must not compete with an already moving paper sheet.
          if (this.preview?.ready) {
            await new Promise(resolve => setTimeout(resolve, 30));
            continue;
          }
          const deadline = performance.now() + 4;
          do {
            const part = builder.next();
            done = part.done;
            if (!done && part.value === null) break;
            if (!done) pages.pages.push(part.value);
          } while (!done && performance.now() < deadline);
          if (!done) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (!pages.pages.length) throw new Error("相邻范围暂时没有可读内容");
        pages.index = direction > 0 ? 0 : Math.floor((pages.pages.length - 1) / pages.count) * pages.count;
        entry.packet = pages;
        return pages;
      } finally {
        clearTimeout(timeout);
        measure?.remove();
      }
    })().catch(error => {
      if (this.ranges.get(next.doc_id) === entry) this.ranges.delete(next.doc_id);
      throw error;
    });
    return entry.promise;
  }
  recordBoundary(preview, completed, reason) {
    if (preview.recorded) return;
    preview.recorded = true;
    const metric = {
      from: this.r.doc.id, to: preview.boundary.doc_id, direction: preview.direction,
      completed, reason, warm: preview.boundaryWarm,
      error: preview.failure || null,
      preparationMs: preview.preparedAt ? +(preview.preparedAt - preview.requested).toFixed(1) : null,
      totalMs: +(performance.now() - preview.requested).toFixed(1),
      landingIndex: preview.destination?.index ?? null,
      sourceStart: preview.destination?.r.doc.pdf?.start_page ?? null,
      sourceEnd: preview.destination?.r.doc.pdf?.end_page ?? null,
      paper: this.painter.scene ? this.painter.metrics?.at(-1) || null : null,
    };
    this.r.ctx.rangeTurns ??= [];
    this.r.ctx.rangeTurns.push(metric);
    this.r.ctx.rangeTurns = this.r.ctx.rangeTurns.slice(-20);
    $(".reader").dataset.rangeTurns = JSON.stringify(this.r.ctx.rangeTurns);
  }
  adopt(pages) {
    this.layout();
    // A comparison pane or a viewport change can alter the landing geometry.
    // Preserve the target source, never reuse pagination measured at another width.
    const fragment = pages.pages[pages.index]?.[0];
    if (this.count !== pages.count || Math.abs(this.width - pages.width) > 1 ||
        Math.abs(this.height - pages.height) > 1) {
      return this.reflow(fragment ? this.r.anchorFor(fragment.id, fragment.start, fragment.start) : null);
    }
    this.generation = pages.generation;
    this.pages = pages.pages;
    this.complete = true;
    this.index = pages.index;
    this.anchor = this.firstAnchor();
    $(".reader").dataset.paginationReady = "true";
    this.render();
    return Promise.resolve();
  }
  async seek(ratio) {
    this.r.emit("before-navigation");
    const offset = Math.round(Math.max(0, Math.min(1, ratio)) * this.length);
    const block =
      this.r.doc.blocks.find(
        (b) => (this.offsets.get(b.id) || 0) + b.text.length >= offset,
      ) || this.r.doc.blocks.at(-1);
    if (block)
      await this.restore(
        this.r.anchorFor(
          block.id,
          Math.min(block.text.length - 1, offset - this.offsets.get(block.id)),
          Math.min(block.text.length - 1, offset - this.offsets.get(block.id)),
        ),
        false,
      );
  }
  indexSource() {
    this.r.annotations = [];
    this.fragments = new Map();
    this.urlRanges = new Map();
    this.inlineStyles = new Map();
    this.inlineObjects = new Map();
    this.blocks = new Map();
    this.offsets = new Map();
    this.length = 0;
    for (const block of this.r.doc.blocks) {
      this.blocks.set(block.id, block);
      this.inlineStyles.set(block.id, pdfInlineStyles(block));
      this.inlineObjects.set(block.id, this.r.doc.pdf
        ? pdfInlineObjects(block, this.r.doc.pdf.book_id) : []);
      this.offsets.set(block.id, this.length);
      this.length += block.text.length;
      const urls = sourceUrlRanges(block.text || "");
      this.urlRanges.set(block.id, urls);
      let cursor = 0;
      this.fragments.set(
        block.id,
        (block.fragments || [{type: "plain", text: block.text || ""}]).map((f) => {
          const item = { ...f, start: cursor, end: cursor + f.text.length };
          cursor = item.end;
          if (overlapsSourceUrl(urls, item.start, item.end)) item.type = "plain";
          if (item.type !== "plain")
            item.annotation =
              this.r.annotations.push({
                ...f,
                start: item.start,
                end: item.end,
                block,
              }) - 1;
          return item;
        }),
      );
    }
  }
  words(text, offset, block) {
    return sourceUrlParts(text, offset, this.urlRanges.get(block) || [])
      .map((part) => {
        if (part.url)
          return `<span class="source-unit source-url" data-source-url data-source-start="${part.start}" data-source-end="${part.end}" data-source-block="${e(block)}">${this.r.highlight(part.text)}</span>`;
        return [...part.text.matchAll(/\S+\s*|\s+/g)]
          .map((m) => {
            const value = m[0],
              word = value.match(
                /[A-Za-z\uFB00-\uFB06]+(?:['’-][A-Za-z\uFB00-\uFB06]+)*/,
              );
            if (!word) return this.r.highlight(value);
            const start = part.start + m.index + word.index,
              end = start + word[0].length;
            return (
              this.r.highlight(value.slice(0, word.index)) +
              `<span class="source-unit" role="button" tabindex="0" data-word="${e(word[0])}" data-source-start="${start}" data-source-end="${end}" data-source-block="${e(block)}" aria-label="查阅 ${e(word[0])}">${this.r.highlight(word[0])}</span>` +
              this.r.highlight(value.slice(word.index + word[0].length))
            );
          })
          .join("");
      })
      .join("");
  }
  markup(fragment, measure = false) {
    const b = this.blocks.get(fragment.id);
    const { start, end } = fragment;
    if (this.visualBlock(b)) {
      const box = b.source?.bbox;
      const width = Math.max(1, b.width || (box && box[2] - box[0]) || 600);
      const height = Math.max(1, b.height || (box && box[3] - box[1]) || 400);
      const available = Math.max(80, parseFloat(this.measure.style.width) || this.width - 64);
      const fitWidth = Math.min(available, width * 2);
      const scale = Math.min(1, Math.max(32, this.height - 100) / (fitWidth * height / width));
      const shownWidth = Math.round(fitWidth * scale), shownHeight = Math.round(shownWidth * height / width);
      const caption = b.type === "image_fallback"
        ? `原图保留${b.source?.page_number ? ` · 来源第 ${b.source.page_number} 页` : ""}`
        : b.caption || "";
      const figure = `<figure data-block="${e(b.id)}" data-start="0" data-end="${b.text.length}" data-pdf-object="${e(b.id)}" class="pdf-object ${e(b.type)}"><img src="${e(b.asset_url)}" alt="${e(caption || "PDF 原图")}" width="${shownWidth}" height="${shownHeight}" style="width:${shownWidth}px;height:${shownHeight}px;max-width:100%;object-fit:contain" draggable="false" decoding="async">${caption ? `<figcaption>${e(caption)}</figcaption>` : ""}</figure>`;
      if (measure) return figure;
      return `<section class="source-fragment pdf-object-fragment" data-fragment="${e(b.id)}" data-fragment-start="0" data-fragment-end="${b.text.length}"><div class="source-row"><span class="grammar-slot" aria-hidden="true"></span>${figure}</div></section>`;
    }
    const tag =
      { heading: "h2", quote: "blockquote", code: "pre" }[b.type] || "p";
    const text = (this.fragments.get(b.id) || [])
      .filter((f) => f.start < end && f.end > start)
      .map((f) => {
        const a = Math.max(start, f.start),
          z = Math.min(end, f.end),
          source = b.text.slice(a, z);
        const render = (value, offset) => measure ? e(value)
          : b.type === "code" ? this.r.highlight(value) : this.words(value, offset, b.id);
        const styles = this.inlineStyles.get(b.id) || [];
        const objects = this.inlineObjects.get(b.id) || [];
        const rendered = styles.length || objects.length
          ? renderPdfInline(source, a, styles, render, objects)
          : render(source, a);
        if (f.type === "plain") return rendered;
        return `<span class="annotation" role="button" tabindex="0" data-target="${e(f.target)}" data-kind="${e(f.kind)}" data-annotation="${f.annotation}" aria-label="${e(source)}：${e(f.note)}"><span class="source-text">${rendered}</span>${z === f.end ? `<span class="gloss" aria-hidden="true">${e(f.note)}</span>` : ""}</span>`;
      })
      .join("");
    const source = `<${tag} data-block="${b.id}" data-start="${start}" data-end="${end}" class="${b.type === "list-item" ? "list-block" : b.type}">${text}</${tag}>`;
    if (measure) return source;
    const actions =
      b.type === "heading"
        ? ""
        : `<div class="paragraph-actions"><button data-read-block="${b.id}" type="button" ${this.r.ctx.enabled("tts") ? "" : "hidden"}>听这一段</button><button data-select-block="${b.id}" type="button">选择这一段</button></div>`;
    return `<section class="source-fragment" data-fragment="${b.id}" data-fragment-start="${start}" data-fragment-end="${end}"><div class="source-row"><span class="grammar-slot" data-grammar-slot="${b.id}"></span>${source}</div>${actions}<section class="inline-grammar" data-grammar-block="${b.id}" hidden></section></section>`;
  }
  visualBlock(block) {
    if (!block || !["image", "image_fallback", "formula", "table"].includes(block.type) || !block.asset_url) return false;
    try {
      const url = new URL(block.asset_url, location.origin);
      return url.origin === location.origin && /^\/api\/pdf\/books\/\d+\/assets\//.test(url.pathname);
    } catch { return false; }
  }
  wake() {
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
  // Build exact pages cooperatively. The first completed page is usable immediately.
  reflow(anchor = this.position()) {
    if (this.r.scope.signal.aborted) return Promise.resolve();
    const generation = ++this.generation;
    this.clearRanges();
    clearTimeout(this.timer);
    this.wake();
    this.finishAnimation();
    this.painter.invalidate();
    this.layout();
    // Keep the currently visible source during font/density/column changes.
    // Replacing it with page one while seeking a late anchor causes a visible jump.
    this.displayPending = Boolean(
      this.validAnchor(anchor) && $("#article").children.length,
    );
    this.pages = [];
    this.index = 0;
    this.complete = false;

    $(".reader").dataset.paginationReady = "false";
    this.flowStarted = performance.now();
    const builder = this.buildPages();
    const advance = () => {
      if (generation !== this.generation || this.r.scope.signal.aborted) return;
      if (this.animating) {
        this.timer = setTimeout(advance, 30);
        return;
      }
      const deadline = performance.now() + 5;
      do {
        const next = builder.next();
        if (next.done) {
          this.complete = true;
          if (!this.pages.length) this.pages = [[]];
          this.measure.replaceChildren();
          $(".reader").dataset.paginationReady = "true";
          $(".reader").dataset.paginationMs = (
            performance.now() - this.flowStarted
          ).toFixed(1);
          this.painter.warm();
          this.warmRanges();
          break;
        }
        if (next.value === null) break;
        this.pages.push(next.value);
      } while (performance.now() < deadline);
      if (this.pages.length && !this.displayPending && this.painted !== generation) {
        this.painted = generation;
        this.anchor = this.firstAnchor();
        this.render();
      } else this.navigationUI();
      this.wake();
      if (!this.complete) this.timer = setTimeout(advance, 0);
    };
    advance();
    return this.restore(anchor, false, {reflow: true});
  }
  *buildPages() {
    const height = this.height;
    let page = [],
      used = 0;
    let sliceStarted = performance.now();
    const measure = function* (part) {
      this.measure.innerHTML = this.markup(part, true);
      const el = this.measure.firstElementChild,
        css = getComputedStyle(el);
      const measured = (
        el.getBoundingClientRect().height +
        parseFloat(css.marginTop) +
        parseFloat(css.marginBottom) +
        2
      );
      // A page can require many forced layouts. Yield inside its binary search,
      // preserving the measured value and all fragment state across the pause.
      // null is a scheduling checkpoint, never a completed reading page.
      if (performance.now() - sliceStarted >= 4) {
        yield null;
        sliceStarted = performance.now();
      }
      return measured;
    }.bind(this);
    for (const b of this.r.doc.blocks) {
      if (this.visualBlock(b)) {
        const part = {id: b.id, start: 0, end: b.text.length, object: true};
        const objectHeight = yield* measure(part);
        if (page.length && used + objectHeight > height) {
          yield page;
          page = [];
          used = 0;
        }
        page.push(part);
        used += Math.min(height, objectHeight);
        continue;
      }
      const ends = [...b.text.matchAll(/\S+\s*/g)].map(
        (m) => m.index + m[0].length,
      );
      if (!ends.length) continue;
      ends[ends.length - 1] = b.text.length;
      let i = 0,
        start = 0;
      while (i < ends.length) {
        let lo = i + 1,
          hi = Math.min(ends.length, i + 240),
          best = i,
          bestHeight = 0;
        // Most book blocks fit whole: avoid a binary search for every paragraph.
        const wholeHeight = yield* measure({ id: b.id, start, end: ends[hi - 1] });
        if (wholeHeight <= height - used) {
          best = hi;
          bestHeight = wholeHeight;
        } else {
          hi--;
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const h = yield* measure({ id: b.id, start, end: ends[mid - 1] });
            if (h <= height - used) {
              best = mid;
              bestHeight = h;
              lo = mid + 1;
            } else hi = mid - 1;
          }
        }
        if (best === i) {
          if (page.length) {
            yield page;
            page = [];
            used = 0;
            continue;
          }
          best = i + 1;
          bestHeight = height;
        }
        const crossing = this.fragments
          .get(b.id)
          .find(
            (f) =>
              f.type !== "plain" &&
              f.start < ends[best - 1] &&
              f.end > ends[best - 1],
          );
        if (crossing) {
          const before = ends.findIndex(
            (v, n) => n >= i && v >= crossing.start,
          );
          if (
            before >= i &&
            before + 1 < best &&
            ends[before] <= crossing.start
          )
            best = before + 1;
        }
        const end = ends[best - 1];
        page.push({ id: b.id, start, end });
        used += bestHeight;
        start = end;
        i = best;
        if (i < ends.length) {
          yield page;
          page = [];
          used = 0;
        }
      }
    }
    if (page.length) yield page;
  }
  validAnchor(anchor) {
    if (this.r.doc.pdf && anchor?.pdf_source) {
      const block = this.r.pdfAnchorBlock(anchor);
      return block ? {...anchor, block_id: block.id} : null;
    }
    return anchor?.block_id &&
      this.r.doc.blocks.some((b) => b.id === anchor.block_id)
      ? anchor
      : null;
  }
  pageFor(anchor) {
    let block = this.r.doc.blocks.find((b) => b.id === anchor?.block_id),
      start = anchor?.start || 0;
    if (this.r.doc.pdf && anchor?.pdf_source) block = this.r.pdfAnchorBlock(anchor);
    if (!block && anchor?.quote) {
      block = this.r.doc.pdf ? null : this.r.doc.blocks.find((b) => b.text.includes(anchor.quote));
      start = block?.text.indexOf(anchor.quote) || 0;
    }
    const i =
      block &&
      this.pages.findIndex((p) =>
        p.some(
          (f) =>
            f.id === block.id &&
            start >= f.start &&
            (start < f.end || (f.end === block.text.length && start === f.end)),
        ),
      );
    if (typeof i === "number" && i >= 0) return i;
    return Math.max(
      0,
      Math.min(
        this.pages.length - 1,
        Math.floor((anchor?.ratio || 0) * this.pages.length),
      ),
    );
  }
  firstAnchor() {
    const f = this.pages[this.index]?.[0];
    return f ? this.r.anchorFor(f.id, f.start, f.start) : { ratio: 0 };
  }
  position() {
    const a = this.anchor || this.firstAnchor();
    return {
      ...a,
      ratio: Math.min(
        1,
        ((this.offsets?.get(a?.block_id) || 0) + (a.start || 0)) /
          Math.max(1, this.length || 0),
      ),
    };
  }
  navigationUI() {
    const total = this.pages.length,
      last = Math.min(total, this.index + this.count);
    $("#reading-page-total").textContent =
      `${this.r.doc.chapter && !this.r.doc.pdf ? "本章 " : ""}${this.index + 1}${last > this.index + 1 ? "–" + last : ""} / ${total}${this.complete ? "" : "+"}`;
    const root = $(".reader");
    this.updateEdges();
    root.dataset.pageIndex = String(this.index);
    root.dataset.pageCount = String(total);
    root.dataset.sourcePosition = JSON.stringify(this.position());
    $(".read-progress div").style.width = this.position().ratio * 100 + "%";
  }
  render() {
    this.painted = this.generation;
    $("#article").innerHTML = Array.from({ length: this.count }, (_, i) =>
      this.leafMarkup(this.index + i),
    ).join("");
    this.navigationUI();
    this.r.renderSelection();
    this.r.ctx.run("draw", this.r).catch(console.error);
    this.r.emit("draw");
    this.painter.warm();
    this.warmRanges();
    if (!$(".reader").dataset.firstSourceMs)
      $(".reader").dataset.firstSourceMs = (
        performance.now() - this.r.ctx.readStarted
      ).toFixed(1);
  }
  lightEnabled() {
    return local.get("page-light", true);
  }
  canGrab(ownPreview = false) {
    return (
      !this.r.scope.signal.aborted &&
      !this.r.focus.isOpen() &&
      !this.r.aiSetupOpen &&
      !this.r.grammarInspecting &&
      !this.r.panelId &&
      !this.r.popElement &&
      !this.r.selection &&
      !getSelection()?.toString().trim() &&
      !document.querySelector("dialog[open]") &&
      $("#translation-pane").hidden &&
      !this.displayPending &&
      (!this.animating || ownPreview)
    );
  }
  updateEdges() {
    const article = $("#article"),
      stage = $("#reading-stage"),
      leaves = [...article.children];
    if (!leaves.length) return;
    const rect = article.getBoundingClientRect(),
      bounds = stage.getBoundingClientRect();
    const enabled = $("#translation-pane").hidden;
    for (const [id, right] of [
      ["reading-edge-prev", false],
      ["reading-edge-next", true],
    ]) {
      const edge = $("#" + id),
        page = leaves[right ? leaves.length - 1 : 0].getBoundingClientRect();
      edge.hidden = !enabled;
      // Only outer paper padding and outer margin; never cover source text/notes.
      Object.assign(edge.style, {
        top: rect.top - bounds.top + 24 + "px",
        height: Math.max(0, rect.height - 48) + "px",
        left: right
          ? page.right - bounds.left - 14 + "px"
          : -bounds.left + "px",
        width: right
          ? innerWidth - page.right + 14 + "px"
          : page.left + 14 + "px",
      });
    }
  }
  commitPage(index) {
    this.r.emit("before-page");
    this.r.closePop();
    this.r.cancelHighlight?.();
    this.r.selection = null;
    getSelection()?.removeAllRanges();
    this.index = index;
    this.anchor = this.firstAnchor();
    this.render();
    this.r.emit("position");
  }
  beginTurn(direction, clientY, force = false) {
    const setup = this.painter.collectPerformance ? { enteredAt: performance.now() } : null;
    if ((!force && !this.canGrab()) || this.animating || this.displayPending)
      return null;
    const target = this.index + direction * this.count;
    const outside = target < 0 || target >= this.pages.length;
    const boundary = outside && this.complete ? this.rangeNeighbor(direction, true) : null;
    if (outside && !boundary) return null;
    this.r.emit("before-navigation");
    document
      .querySelectorAll("#article .actions-visible")
      .forEach((el) => el.classList.remove("actions-visible"));
    const article = $("#article"),
      rect = article.getBoundingClientRect(),
      elements = [...article.children],
      element = elements[direction > 0 && this.count === 2 ? 1 : 0],
      leaf = element.getBoundingClientRect(),
      generation = this.generation,
      token = ++this.navigation,
      frontIndex = this.index + (direction > 0 ? this.count - 1 : 0);
    const preview = (this.preview = {
      requested: performance.now(),
      setup,
      progress: 0.008,
      dy: 0,
      grab: Math.max(0.02, Math.min(0.98, (clientY - leaf.top) / leaf.height)),
      ready: false,
      cancelled: false,
      raf: 0,
      boundary,
      direction,
      boundaryWarm: Boolean(boundary && this.ranges.get(boundary.doc_id)?.packet),
    });
    this.animating = true;
    if (setup) {
      setup.previewCreatedAt = performance.now();
      this.painter.attachSetup = null;
    }
    $(".reader").dataset.pageTurning = "true";
    const valid = () =>
      this.preview === preview &&
      !preview.cancelled &&
      token === this.navigation &&
      generation === this.generation &&
      !this.r.scope.signal.aborted;
    const done = (complete, reason) => {
      if (!valid()) return;
      this.painter.record(complete, reason, preview.requested, preview.settle, preview.setup);
      clearTimeout(preview.timeout);
      clearTimeout(preview.loadingTimer);
      if (boundary) this.recordBoundary(preview, complete, reason);
      this.preview = null;
      this.finishAnimation("settled");
      if (complete && boundary) this.r.ctx.commitReadingRange(this.r, preview.destination);
      else if (complete) this.commitPage(target);
      else this.painter.warm();
    };
    const draw = () => {
      preview.raf = 0;
      if (valid() && preview.ready) {
        if (preview.following) {
          const delta = preview.target - preview.progress;
          preview.progress +=
            Math.sign(delta) * Math.min(0.06, Math.abs(delta));
          preview.following = Math.abs(delta) > 0.06;
        }
        this.painter.draw(
          preview.progress,
          preview.grab,
          preview.dy,
          preview.inputAt,
        );
        if (preview.following) preview.raf = requestAnimationFrame(draw);
        else if (preview.release)
          settle(
            preview.release.complete,
            preview.release.reason,
            preview.release.options,
          );
      }
      preview.inputAt = 0;
    };
    const settle = (complete, reason, options) => {
      if (!valid()) return;
      if (boundary && !complete && !preview.ready) {
        done(false, reason);
        return;
      }
      preview.release = {
        complete,
        reason,
        options,
        at: preview.release?.at ?? performance.now(),
      };
      if (!preview.ready || preview.following) return;
      cancelAnimationFrame(preview.raf);
      if (!this.painter.scene) {
        clearTimeout(preview.confirmTimer);
        preview.confirmTimer = setTimeout(
          () => done(complete, reason),
          Math.max(0, (options?.notBefore || 0) - performance.now()),
        );
        return;
      }
      $(".reader").dataset.curlPhase = "settling";
      const from = preview.progress,
        to = complete ? 1 : 0,
        dy = preview.dy,
        start = performance.now(),
        native = reason.startsWith("native-"),
        trackpad = reason.startsWith("trackpad-"),
        duration = native
          ? Math.max(100, Math.min(180, Math.abs(to - from) * 250))
          : trackpad
          ? complete
            ? Math.max(160, Math.min(360, Math.abs(to - from) * 450))
            : Math.max(180, Math.min(480, from * 450))
          : complete
            ? Math.max(240, Math.min(540, Math.abs(to - from) * 560))
            : 220;
      preview.settle = {
        from,
        start,
        releaseAt: preview.release.at,
        inputAt: options?.inputAt,
        duration,
      };
      const frame = (now) => {
        if (!valid()) return;
        const t = Math.min(1, (now - start) / duration),
          // Smooth in both directions; cancel no longer snaps with a short
          // ease-out. Confirmation is separate from this reversible preview.
          ease = trackpad ? t * t * (3 - 2 * t) : 1 - Math.pow(1 - t, 3);
        const confirmed = now >= (options?.notBefore || 0);
        let desired = from + (to - from) * ease;
        if (complete && !confirmed) desired = Math.min(0.98, desired);
        const delta = desired - preview.progress;
        preview.progress = native || trackpad
          ? preview.progress +
            Math.sign(delta) * Math.min(native ? 0.08 : 0.065, Math.abs(delta))
          : desired;
        preview.dy = dy * (1 - ease);
        this.painter.draw(preview.progress, preview.grab, preview.dy);
        if (t < 1 || !confirmed || Math.abs(to - preview.progress) > 0.00001)
          preview.raf = requestAnimationFrame(frame);
        else done(complete, reason);
      };
      preview.raf = requestAnimationFrame(frame);
    };
    const session = {
      turnDistance:
        leaf.width * 2 +
        (this.count === 2
          ? elements[1].getBoundingClientRect().left -
            elements[0].getBoundingClientRect().right
          : 0),
      height: leaf.height,
      update: (p, dy, inputAt, catchUp = false) => {
        if (!valid() || preview.release) return;
        if (catchUp || preview.following) {
          preview.target = p;
          preview.following = true;
        } else preview.progress = p;
        preview.dy = dy;
        preview.inputAt = inputAt;
        if (preview.ready && !preview.raf)
          preview.raf = requestAnimationFrame(draw);
      },
      release: settle,
      resume: () => {
        if (!valid()) return null;
        cancelAnimationFrame(preview.raf);
        clearTimeout(preview.confirmTimer);
        preview.raf = 0;
        preview.release = null;
        preview.settle = null;
        preview.following = false;
        $(".reader").dataset.curlPhase = "dragging";
        return preview.progress;
      },
      cancel: (reason) => {
        if (valid()) this.finishAnimation(reason);
      },
    };
    const motionOff = local.get("page-motion", "curl") === "off" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches || this.painter.failed;
    if (!boundary && motionOff) { preview.ready = true; return session; }
    const before = article.cloneNode(true),
      incoming = article.cloneNode(false);
    if (setup) setup.clonedAt = performance.now();
    before.removeAttribute("id");
    incoming.removeAttribute("id");
    before
      .querySelectorAll("[id],.paragraph-actions")
      .forEach((el) =>
        el.matches(".paragraph-actions")
          ? el.remove()
          : el.removeAttribute("id"),
      );
    elements.forEach(
      (el, i) =>
        (before.children[i].dataset.leafX =
          el.getBoundingClientRect().left - rect.left),
    );
    const ready = (front, back) => {
      if (!valid() || preview.ready) return;
      if (setup) setup.readyEnteredAt = performance.now();
      clearTimeout(preview.timeout);
      clearTimeout(preview.loadingTimer);
      if (!motionOff) this.painter.attach(
        before,
        incoming,
        direction,
        front,
        back,
        preview.grab,
      );
      if (setup) setup.attachReturnedAt = performance.now();
      preview.ready = true;
      draw();
      if (setup) setup.initialDrawReturnedAt = performance.now();
      if (preview.release && !preview.following && !preview.raf)
        settle(
          preview.release.complete,
          preview.release.reason,
          preview.release.options,
        );
    };
    const prepare = async (source, index) => {
      if (!valid()) return;
      if (setup) setup.incomingStartedAt = performance.now();
      const backIndex = index + (direction < 0 ? this.count - 1 : 0);
      incoming.innerHTML = Array.from({ length: this.count }, (_, i) => source.leafMarkup(index + i)).join("");
      incoming.querySelectorAll(".paragraph-actions").forEach(el => el.remove());
      if (setup) setup.incomingReadyAt = performance.now();
      this.painter.wasWarm = this.painter.cache.has(this.painter.key(frontIndex)) &&
        this.painter.cache.has(this.painter.key(backIndex, source));
      if (motionOff) { ready(null, null); return; }
      if (!boundary) preview.timeout = setTimeout(() => {
        $(".reader").dataset.curlFallback = "texture-timeout";
        ready(null, null);
      }, 1200);
      const [front, back] = await Promise.all([
        this.painter.prepare(frontIndex), this.painter.prepare(backIndex, source),
      ]);
      if (setup) setup.texturesReadyAt = performance.now();
      if (!valid()) return;
      if (boundary && (!front || !back) && !this.painter.failed)
        throw new Error("相邻页面图像尚未准备");
      ready(front, back);
    };
    if (boundary) {
      preview.loadingTimer = setTimeout(() => {
        if (valid() && !preview.ready) this.r.status("正在准备相邻页面，当前阅读位置保留…", {notice: true});
      }, 700);
      preview.timeout = setTimeout(() => {
        if (!valid()) return;
        done(false, "range-timeout");
        this.r.status("相邻页面暂未准备好，当前页面已保留。再次翻页可重试。", {notice: true});
      }, 15000);
      this.prepareRange(direction).then(source => {
        if (!valid()) return;
        preview.destination = source;
        preview.preparedAt = performance.now();
        return prepare(source, source.index);
      }).catch(error => {
        if (!valid()) return;
        preview.failure = error.name === "AbortError" ? "请求已中止或超时" : error.message;
        done(false, "range-error");
        this.r.status(`相邻页面未能加载，当前页面已保留；再次翻页可重试。${error.name === "AbortError" ? "" : " " + error.message}`, {notice: true});
      });
    } else prepare(this, target);
    return session;
  }
  async turn(index, animate = false) {
    if (
      this.displayPending ||
      this.animating ||
      index < 0 ||
      index === this.index
    )
      return;
    const navigation = ++this.navigation,
      generation = this.generation;
    while (!this.complete && index >= this.pages.length) {
      await new Promise((resolve) => this.waiters.push(resolve));
      if (
        navigation !== this.navigation ||
        generation !== this.generation ||
        this.r.scope.signal.aborted
      )
        return;
    }
    if (index >= this.pages.length || this.r.scope.signal.aborted) return;
    if (
      animate &&
      Math.abs(index - this.index) === this.count &&
      $("#translation-pane").hidden
    ) {
      const rect = $("#article").getBoundingClientRect(),
        session = this.beginTurn(
          Math.sign(index - this.index),
          rect.top + rect.height * 0.68,
          true,
        );
      session?.release(true, "tap");
    } else {
      this.r.emit("before-navigation");
      this.commitPage(index);
    }
  }
  async restore(anchor, mark = true, {reflow = false} = {}) {
    if (mark && anchor?.block_id) {
      const visible = [
        ...document.querySelectorAll("#article [data-block]"),
      ].some(
        (el) =>
          el.dataset.block === anchor.block_id &&
          (anchor.start || 0) >= +el.dataset.start &&
          (anchor.start || 0) < +el.dataset.end,
      );
      if (!visible) this.r.emit("before-navigation");
    }
    this.finishAnimation();
    const navigation = ++this.navigation,
      generation = this.generation;
    const hasPage = () =>
      anchor?.block_id &&
      this.pages.some((p) =>
        p.some(
          (f) =>
            f.id === anchor.block_id &&
            (anchor.start || 0) >= f.start &&
            ((anchor.start || 0) < f.end ||
              f.end === this.blocks.get(f.id)?.text.length),
        ),
      );
    while (
      !this.complete &&
      (!this.pages.length || (!hasPage() &&
        (anchor?.block_id || anchor?.quote || anchor?.ratio > 0)))
    ) {
      await new Promise((resolve) => this.waiters.push(resolve));
      if (
        navigation !== this.navigation ||
        generation !== this.generation ||
        this.r.scope.signal.aborted
      )
        return false;
    }
    if (
      navigation !== this.navigation ||
      generation !== this.generation ||
      this.r.scope.signal.aborted
    )
      return false;
    const index = this.pageFor(anchor);
    this.displayPending = false;
    if (index !== this.index) this.r.emit("before-page", {reflow});
    this.index = index;
    this.anchor = this.validAnchor(anchor) || this.firstAnchor();
    this.render();
    const el = [...document.querySelectorAll("#article [data-block]")].find(
      (el) => el.dataset.block === this.anchor.block_id,
    );
    if (mark) el?.classList.add("anchor-flash");
    this.r.emit("position");
    return true;
  }
}
