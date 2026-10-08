import { $, e, local } from "./core.js";

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
    this.painter = new PageCurlRenderer(this);
    this.generation = 0;
    this.navigation = 0;
    this.waiters = [];
    this.complete = true;
    this.edge = installReadingEdgeDrag(this);
    this.measure = document.createElement("article");
    this.measure.className = "reading-prose reading-page-measure";
    this.measure.setAttribute("aria-hidden", "true");
    document.querySelector(".reader").append(this.measure);
    const scope = reader.scope;
    let pixelRatio = devicePixelRatio || 1;
    scope.on(window, "resize", () => {
      if (pixelRatio === (devicePixelRatio || 1)) return;
      pixelRatio = devicePixelRatio || 1;
      this.invalidatePaint();
    });
    scope.cleanup(() => {
      this.finishAnimation("route-leave");
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
    scope.cleanup(() => {
      resize.disconnect();
      clearTimeout(timer);
    });
  }
  layoutChanged(rect) {
    return (
      Math.abs(rect.width - (this.containerWidth || 0)) > 1 ||
      Math.abs(rect.height - (this.containerHeight || 0)) > 1
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
    this.width = rect.width;
    this.height = Math.max(
      72,
      box.height -
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
      this.painter.record(false, reason, preview.requested);
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
      const chapter = this.r.doc.chapter,
        chapters = this.r.doc.chapters;
      const next = chapter && chapters[chapter.idx + direction];
      if (next) this.r.ctx.navigate("#/read/" + next.doc_id);
      else this.r.status(direction > 0 ? "已到本篇末尾" : "已到本篇开头");
      return;
    }
    return this.turn(Math.max(0, target), true);
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
    this.blocks = new Map();
    this.offsets = new Map();
    this.length = 0;
    for (const block of this.r.doc.blocks) {
      this.blocks.set(block.id, block);
      this.offsets.set(block.id, this.length);
      this.length += block.text.length;
      let cursor = 0;
      this.fragments.set(
        block.id,
        block.fragments.map((f) => {
          const item = { ...f, start: cursor, end: cursor + f.text.length };
          cursor = item.end;
          if (f.type !== "plain")
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
    return [...text.matchAll(/\S+\s*|\s+/g)]
      .map((m) => {
        const value = m[0],
          word = value.match(
            /[A-Za-z\uFB00-\uFB06]+(?:['’-][A-Za-z\uFB00-\uFB06]+)*/,
          );
        if (!word) return this.r.highlight(value);
        const start = offset + m.index + word.index,
          end = start + word[0].length;
        return (
          this.r.highlight(value.slice(0, word.index)) +
          `<span class="source-unit" role="button" tabindex="0" data-word="${e(word[0])}" data-source-start="${start}" data-source-end="${end}" data-source-block="${e(block)}" aria-label="查阅 ${e(word[0])}">${this.r.highlight(word[0])}</span>` +
          this.r.highlight(value.slice(word.index + word[0].length))
        );
      })
      .join("");
  }
  markup(fragment, measure = false) {
    const b = this.blocks.get(fragment.id);
    const { start, end } = fragment;
    const tag =
      { heading: "h2", quote: "blockquote", code: "pre" }[b.type] || "p";
    const text = (this.fragments.get(b.id) || [])
      .filter((f) => f.start < end && f.end > start)
      .map((f) => {
        const a = Math.max(start, f.start),
          z = Math.min(end, f.end),
          source = b.text.slice(a, z);
        const rendered = measure
          ? e(source)
          : b.type === "code"
            ? this.r.highlight(source)
            : this.words(source, a, b.id);
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
  wake() {
    this.waiters.splice(0).forEach((resolve) => resolve());
  }
  // Build exact pages cooperatively. The first completed page is usable immediately.
  reflow(anchor = this.position()) {
    if (this.r.scope.signal.aborted) return Promise.resolve();
    const generation = ++this.generation;
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
          break;
        }
        this.pages.push(next.value);
      } while (performance.now() < deadline);
      if (!this.displayPending && this.painted !== generation) {
        this.painted = generation;
        this.anchor = this.firstAnchor();
        this.render();
      } else this.navigationUI();
      this.wake();
      if (!this.complete) this.timer = setTimeout(advance, 0);
    };
    advance();
    return this.restore(anchor, false);
  }
  *buildPages() {
    const height = this.height;
    let page = [],
      used = 0;
    const measure = (part) => {
      this.measure.innerHTML = this.markup(part, true);
      const el = this.measure.firstElementChild,
        css = getComputedStyle(el);
      return (
        el.getBoundingClientRect().height +
        parseFloat(css.marginTop) +
        parseFloat(css.marginBottom) +
        2
      );
    };
    for (const b of this.r.doc.blocks) {
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
        const wholeHeight = measure({ id: b.id, start, end: ends[hi - 1] });
        if (wholeHeight <= height - used) {
          best = hi;
          bestHeight = wholeHeight;
        } else {
          hi--;
          while (lo <= hi) {
            const mid = Math.floor((lo + hi) / 2);
            const h = measure({ id: b.id, start, end: ends[mid - 1] });
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
    return anchor?.block_id &&
      this.r.doc.blocks.some((b) => b.id === anchor.block_id)
      ? anchor
      : null;
  }
  pageFor(anchor) {
    let block = this.r.doc.blocks.find((b) => b.id === anchor?.block_id),
      start = anchor?.start || 0;
    if (!block && anchor?.quote) {
      block = this.r.doc.blocks.find((b) => b.text.includes(anchor.quote));
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
      `${this.index + 1}${last > this.index + 1 ? "–" + last : ""} / ${total}${this.complete ? "" : "+"}`;
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
    if ((!force && !this.canGrab()) || this.animating || this.displayPending)
      return null;
    const target = this.index + direction * this.count;
    if (target < 0 || target >= this.pages.length) return null;
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
      frontIndex = this.index + (direction > 0 ? this.count - 1 : 0),
      backIndex = target + (direction < 0 ? this.count - 1 : 0);
    const preview = (this.preview = {
      requested: performance.now(),
      progress: 0.008,
      dy: 0,
      grab: Math.max(0.02, Math.min(0.98, (clientY - leaf.top) / leaf.height)),
      ready: false,
      cancelled: false,
      raf: 0,
    });
    this.animating = true;
    $(".reader").dataset.pageTurning = "true";
    const valid = () =>
      this.preview === preview &&
      !preview.cancelled &&
      token === this.navigation &&
      generation === this.generation &&
      !this.r.scope.signal.aborted;
    const done = (complete, reason) => {
      if (!valid()) return;
      this.painter.record(complete, reason, preview.requested, preview.settle);
      this.preview = null;
      this.finishAnimation("settled");
      if (complete) this.commitPage(target);
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
    if (
      local.get("page-motion", "curl") === "off" ||
      matchMedia("(prefers-reduced-motion: reduce)").matches ||
      this.painter.failed
    ) {
      preview.ready = true;
      return session;
    }
    const before = article.cloneNode(true),
      incoming = article.cloneNode(false);
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
    incoming.innerHTML = Array.from({ length: this.count }, (_, i) =>
      this.leafMarkup(target + i),
    ).join("");
    incoming
      .querySelectorAll(".paragraph-actions")
      .forEach((el) => el.remove());
    this.painter.wasWarm =
      this.painter.cache.has(this.painter.key(frontIndex)) &&
      this.painter.cache.has(this.painter.key(backIndex));
    const ready = (front, back) => {
      if (!valid() || preview.ready) return;
      clearTimeout(preview.timeout);
      this.painter.attach(
        before,
        incoming,
        direction,
        front,
        back,
        preview.grab,
      );
      preview.ready = true;
      draw();
      if (preview.release && !preview.following && !preview.raf)
        settle(
          preview.release.complete,
          preview.release.reason,
          preview.release.options,
        );
    };
    preview.timeout = setTimeout(() => {
      $(".reader").dataset.curlFallback = "texture-timeout";
      ready(null, null);
    }, 1200);
    Promise.all([
      this.painter.prepare(frontIndex),
      this.painter.prepare(backIndex),
    ]).then(([front, back]) => ready(front, back));
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
  async restore(anchor, mark = true) {
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
      !hasPage() &&
      (anchor?.block_id || anchor?.quote || anchor?.ratio > 0)
    ) {
      await new Promise((resolve) => this.waiters.push(resolve));
      if (
        navigation !== this.navigation ||
        generation !== this.generation ||
        this.r.scope.signal.aborted
      )
        return;
    }
    if (
      navigation !== this.navigation ||
      generation !== this.generation ||
      this.r.scope.signal.aborted
    )
      return;
    const index = this.pageFor(anchor);
    this.displayPending = false;
    if (index !== this.index) this.r.emit("before-page");
    this.index = index;
    this.anchor = this.validAnchor(anchor) || this.firstAnchor();
    this.render();
    const el = [...document.querySelectorAll("#article [data-block]")].find(
      (el) => el.dataset.block === this.anchor.block_id,
    );
    if (mark) el?.classList.add("anchor-flash");
    this.r.emit("position");
  }
}
