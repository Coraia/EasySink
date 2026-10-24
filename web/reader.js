import { actionIcon } from "./reading-action-icons.js";
import { sameSelection } from "./source-selection.js";
import { renderDictionaryCard } from "./dictionary-card.js";
import { anchorFromDOMRange, sourceRuns } from "./selection-range.js";
import { $, $$, e, api, Scope, local, toast, errorBox } from "./core.js";
import { ReadingPages } from "./pagination.js?v=20261018-keyboard-paging-tuned";
import { captureAnnotationLayout, updateAnnotationLayout, captureRetainedWordLayout, reconcileRetainedWordLayout } from "./annotation-layout.js";
import { setupReadingInteractions } from "./reading-interactions.js?v=20261006-grab1";
import { installReadingTraces } from "./reading-traces.js";
import {
  readerShell,
  installReaderChrome,
  installCoreReaderTools,
  readerIcon,
} from "./reader-chrome.js?v=20261018-keyboard-paging-tuned";
export class Reader {
  static inputVeilAlpha(value) {
    const color=String(value ?? "").trim().toLowerCase();
    if(color==="transparent")return 0;
    const slash=color.match(/^rgba?\(([^/()]*)\/([^/()]*)\)$/);
    let channels,alpha;
    if(slash){channels=slash[1].trim().split(/\s+/);alpha=slash[2].trim();}
    else {
      const rgba=color.match(/^rgba\(([^()]*)\)$/);
      if(!rgba)return 1; // Three-channel rgb(), including black, is opaque.
      const parts=rgba[1].split(",").map(s=>s.trim());
      if(parts.length!==4)return 1;
      channels=parts.slice(0,3);alpha=parts[3];
    }
    const number=/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(%?)$/;
    if(channels.length!==3 || !channels.every(channel=>{
      const match=channel.match(number),n=Number(match?.[1]);
      return match && Number.isFinite(n) && n>=0 && n<=(match[2]?100:255);
    }))return 1;
    const match=alpha.match(number);
    if(!match)return 1;
    const n=Number(match[1])/(match[2]?100:1);
    return Number.isFinite(n) && n>=0 && n<=1?n:1;
  }
  constructor(ctx, scope, doc, handoff = null) {
    this.ctx = ctx;
    this.scope = scope;
    this.doc = doc;
    this.sourceBlocks = handoff?.pages.r.sourceBlocks || doc.blocks;
    this.generation = 0;
    this.lookups = 0;
    this.panelScope = null;
    this.panelId = null;
    this.search = "";
    this.selection = null;
    this.restoring = true;
    this.handoff = handoff;
    this.collectionsSeed = handoff?.pages.r.collectionsSeed;
  }
  async mount() {
    const d = this.doc;
    document.body.classList.add("reading");
    $("#header-context").textContent = d.title;
    document.body.classList.add("paged-reading");
    this.ctx.root.innerHTML = readerShell(d, this.ctx.enabled("progress"));
    installReaderChrome(this);
    setupReadingInteractions(this);
    await this.ctx.run("prepare-reading", this);
    if (this.scope.signal.aborted) return;
    this.on("annotations-change", () => {
      // Reapply occurrence feedback to the unchanged source. No server request,
      // global mastery change or whole-book reload is needed.
      this.annotationDrawPromise = this.draw({preserveLayout: true});
      this.annotationDrawPromise.catch(error => {
        if (error.name !== "AbortError") this.status(error.message);
      });
    });
    this.pages = new ReadingPages(this);
    await this.draw();
    const s = this.scope;
    s.on($(".density-control"), "click", (ev) => {
      const b = ev.target.closest("[data-density]");
      if (b) this.density(+b.dataset.density);
    });
    s.on($("#article"), "click", (ev) => {
      if (this.suppressWordClick || this.selecting || ev.detail > 1 || window.getSelection()?.toString()) return;
      const el = ev.target.closest("[data-annotation]");
      if (el) this.pop(el);
      else {
        const unit = ev.target.closest("[data-word]");
        if (unit) {
          const anchor = this.anchorFor(
            unit.dataset.sourceBlock,
            +unit.dataset.sourceStart,
            +unit.dataset.sourceEnd,
          );
          this.lookup(unit.dataset.word, unit, anchor);
        }
      }
    });
    s.on($("#article"), "keydown", (ev) => {
      if (
        (ev.key === "Enter" || ev.key === " ") &&
        ev.target.matches("[data-annotation],[data-word]")
      ) {
        ev.preventDefault();
        this.suppressWordClick = false;
        if (ev.target.matches("[data-annotation]")) this.pop(ev.target);
        else
          this.lookup(
            ev.target.dataset.word,
            ev.target,
            this.anchorFor(
              ev.target.dataset.sourceBlock,
              +ev.target.dataset.sourceStart,
              +ev.target.dataset.sourceEnd,
            ),
          );
      }
    });
    s.on(document, "selectionchange", () => this.captureSelection());
    s.on(
      window,
      "scroll",
      () => {
        const track = $(".read-progress div");
        if (track) track.style.width = `${this.position().ratio * 100}%`;
      },
      { passive: true },
    );
    s.on($("#finish-reading"), "click", async (ev) => {
      try {
        await api(`/documents/${d.id}/finish`, {
          method: "POST",
          body: {
            annotation_count: this.doc.annotation_count,
            manual_lookups: this.lookups,
            felt_density: "读完",
          },
        });
        ev.target.textContent = "已记录 ✓";
        toast("阅读已记录，原始痕迹已保留。");
        this.showTraces?.();
      } catch (err) {
        toast(err.message);
      }
    });
    s.on($("#archive-reading"), "click", async (ev) => {
      try {
        await api(
          `/documents/${d.id}/${this.doc.archived ? "restore" : "archive"}`,
          { method: "POST" },
        );
        this.doc.archived = !this.doc.archived;
        ev.target.textContent = this.doc.archived ? "移回书架" : "归档";
        toast(this.doc.archived ? "已归档，笔记和书签仍保留" : "已移回书架");
      } catch (err) {
        toast(err.message);
      }
    });
    if (d.chapters.length) {
      const currentChapter = d.chapters.findIndex(ch => ch.doc_id === d.id);
      $("#chapter-nav").innerHTML = d.chapters
        .map((ch, i) =>
          Math.abs(i - currentChapter) === 1
            ? `<a class="button" href="#/read/${ch.doc_id}">${i < currentChapter ? "← 上一章" : "下一章 →"}</a>`
            : "",
        )
        .join(" ");
    }
    this.tool("outline", "目录", () => this.outline());
    s.cleanup(() => {
      this.panelScope?.dispose();
      this.closePop();
      document.body.classList.remove("reading", "immersive", "paged-reading");
    });
    try {
      this.assists = await api(`/documents/${d.id}/assists`, {
        signal: s.signal,
      });
    } catch (err) {
      if (err.name !== "AbortError")
        this.status("阅读痕迹暂时无法加载，正文仍可阅读");
    }
    if (s.signal.aborted) return;
    await this.ctx.run("read", this);
    if (s.signal.aborted) return;
    installReadingTraces(this);
    installCoreReaderTools(this);
    // A physical boundary turn has an explicit first/last-spread landing.
    // Old resume state must not replace it while optional tools are mounting.
    const selector = this.handoff ? null : local.get(`jump:${d.id}`);
    if (selector) {
      local.remove(`jump:${d.id}`);
      await this.restore(selector, { automatic: selector.resume_position === true, mark: !selector.resume_position, alignStart: selector.resume_position === true });
    }
    const translationJump = this.handoff ? null : local.get(`translation-jump:${d.id}`);
    if (translationJump) {
      local.remove(`translation-jump:${d.id}`);
      const saved = this.assists.find((a) => a.id === translationJump);
      if (saved) this.showTranslation?.(saved);
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (s.signal.aborted) return;
        this.restoring = false;
        this.pages.markStable();
        // Explicit directory/note jumps are a new reading position, not merely
        // resuming the old one. Persist after the initial restore guard lifts.
        if (selector || this.handoff || this.resumePositionMapped) this.emit("position");
        this.resumePositionMapped = false;
        this.handoff = null;
        $(".reader")?.setAttribute("data-ready", "true");
        $(".reader").dataset.readyMs = (
          performance.now() - this.ctx.readStarted
        ).toFixed(1);
      }),
    );
    local.set("last-document", d.id);
    if (d.chapter) local.set(`book-chapter:${d.chapter.book_id}`, d.id);
  }
  tool(id, label, fn) {
    const button = document.createElement("button");
    button.id = `tool-${id}`;
    const primary = [
      "outline",
      "notes",
      "collections",
      "progress",
      "appearance",
      "typography",
      "more",
    ].includes(id);
    button.setAttribute("aria-label", label);
    button.title = label;
    button.className = primary ? "reader-icon" : "reader-secondary-tool";
    button.innerHTML = primary ? readerIcon(id) : e(label);
    button.dataset.tool = id;
    button.setAttribute("aria-pressed", "false");
    if (primary) {
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-controls", "tool-panel");
    }
    $(primary ? "#reader-actions" : "#reader-extra-tools").append(button);
    this.scope.on(button, "click", () =>
      Promise.resolve(fn()).catch((err) => toast(err.message)),
    );
    return button;
  }
  async panel(id, title, html, mount, options = {}) {
    if (this.panelId === id) {
      this.closePanel();
      return null;
    }
    this.panelScope?.dispose();
    this.panelScope = new Scope();
    const scope = this.panelScope;
    this.panelId = id;
    this.panelClose = options.onClose;
    this.positionSelection?.();
    const el = $("#tool-panel");
    el.innerHTML = `<div class="panel-header"><h2>${e(title)}</h2><button class="icon-button" aria-label="关闭侧栏">×</button></div><div class="panel-content">${html}</div>`;
    el.hidden = false;
    $("#panel-dismiss").hidden = false;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", title);
    $$("#reader-actions [data-tool]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.tool === id));
      b.setAttribute("aria-expanded", String(b.dataset.tool === id));
    });
    scope.on($(".panel-header button", el), "click", () => this.dismissPanel());
    if (id === "outline")
      this.mountBookmarkList?.($(".panel-content", el), scope);
    try {
      await mount?.($(".panel-content", el), scope);
    } catch (err) {
      if (!scope.signal.aborted) {
        $(".panel-content", el).insertAdjacentHTML("afterbegin", errorBox(err));
      }
    }
    return scope;
  }
  dismissPanel() {
    const onClose = this.panelClose;
    this.closePanel();
    onClose?.();
  }
  closePanel() {
    this.panelScope?.dispose();
    this.panelScope = null;
    this.panelId = null;
    this.panelClose = null;
    this.emit?.("reading-uncovered");
    this.positionSelection?.();
    $("#tool-panel").hidden = true;
    $("#panel-dismiss").hidden = true;

    $$("#reader-actions [data-tool]").forEach((b) => {
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-expanded", "false");
    });
  }
  outline() {
    if (this.pdfTools) return this.pdfTools.outline();
    const bookHeader = this.book
      ? `<p class="muted"><a href="#/book/${this.book.id}">${e(this.book.title)}</a> · ${this.doc.chapters.length} 章</p>`
      : "";
    this.panel(
      "outline",
      "阅读目录",
      bookHeader + (this.doc.chapters.length
        ? this.doc.chapters
            .map(
              (ch) =>
                `<a class="toc-link ${ch.doc_id === this.doc.id ? "active" : ""}" href="#/read/${ch.doc_id}">${ch.idx + 1}. ${e(ch.title)}</a>`,
            )
            .join("")
        : this.doc.blocks
            .filter((b) => b.type === "heading")
            .map(
              (b) =>
                `<button class="toc-link" data-jump="${b.id}">${e(b.text)}</button>`,
            )
            .join("") ||
            '<p class="muted">这是一篇短文，可以直接从头阅读。</p>'),
      (el, s) =>
        s.on(el, "click", (ev) => {
          const b = ev.target.closest("[data-jump]");
          if (b) {
            this.restore({ block_id: b.dataset.jump });
            this.closePanel();
          }
        }),
    );
  }
  highlight(text) {
    if (!this.search) return e(text);
    const safe = this.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text
      .split(new RegExp(`(${safe})`, "ig"))
      .map((s, i) => (i % 2 ? `<mark class="search-hit">${e(s)}</mark>` : e(s)))
      .join("");
  }
  draw({preserveLayout = false} = {}) {
    const liveReflow = preserveLayout && this.pages.wordReflow.eligible();
    const retained = preserveLayout && !liveReflow ? captureRetainedWordLayout(this.pages) : null;
    const layout = preserveLayout && !liveReflow && !retained
      ? captureAnnotationLayout(this.pages) || this.pages.annotationLayout
      : null;
    this.doc.blocks = this.collectionsController?.applyAnnotations(this.sourceBlocks) || this.sourceBlocks;
    this.pages.indexSource({preserveAnnotations: liveReflow || Boolean(retained)});
    if (!liveReflow && !retained) this.pages.annotationLayout = layout
      ? updateAnnotationLayout(layout, this.annotations)
      : null;
    const prepared = this.handoff?.pages;
    const ready = retained ? reconcileRetainedWordLayout(this.pages, retained) : liveReflow ? this.pages.wordReflow.update().then(updated => {
      if (!updated) return this.pages.reflow(this.pages.position(), {reason: "annotation"});
    }) : prepared && !this.handoff.adopted
      ? (this.handoff.adopted = true, this.pages.adopt(prepared))
      : this.pages.reflow(this.pages.position(), {reason: preserveLayout ? "annotation" : "source"});
    $("#annotation-meta").textContent =
      `${this.doc.annotation_count} 处辅助理解`;
    $("#density-hint").textContent = this.doc.forced_count
      ? `${this.doc.automatic_count} 处自动辅助 + ${this.doc.forced_count} 处你保留的注释；保留词不会占用自动辅助名额。`
      : this.doc.automatic_count < this.doc.automatic_budget
        ? "当前档位的可用注释已全部显示；‘多’会扩大词汇解释范围。"
        : "单击单词查阅或反馈；拖选文字使用浮动工具条。";

    $$("[data-density]").forEach((b) => {
      const active = +b.dataset.density === this.doc.density;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
    return ready;
  }
  async refresh(density, {pdfBackground = false, nextDocument = null, preserveLayout = false} = {}) {
    if (this.scope.signal.aborted) return;
    if (pdfBackground && (this.restoring || !this.pdfCanRefresh?.())) return false;
    const generation = ++this.generation;
    let anchor = this.position();
    let restoredPosition = false;
    this.restoring = true;
    try {
      const doc = nextDocument || await api(
        `/documents/${this.doc.id}?compact=true${density !== undefined ? "&density=" + density : ""}`,
        { signal: this.scope.signal },
      );
      if (this.scope.signal.aborted || generation !== this.generation) return;
      if (doc.id !== this.doc.id || (pdfBackground && !this.pdfCanRefresh?.())) return false;
      if (pdfBackground && doc.density !== this.doc.density) return false;
      if (pdfBackground && doc.pdf && anchor.pdf_source && doc.version !== this.doc.version) {
        // A live position is not a stored quotation. Stamp only a proven mapping
        // so leaving immediately after refresh cannot persist the old revision.
        anchor = this.pdfTools?.normalizedPosition(anchor, doc) || anchor;
      }
      if (doc.pdf && anchor.pdf_source && !this.pdfAnchorBlock(anchor, doc)) {
        const position = pdfBackground && this.pdfTools?.normalizedPosition(anchor, doc);
        if (!position) return false;
        anchor = position;
      }
      if (pdfBackground && doc.version === this.doc.version && doc.density === this.doc.density) {
        this.doc.pdf = doc.pdf;
        this.doc.chapters = doc.chapters;
        return true;
      }
      preserveLayout &&= doc.version === this.doc.version;
      this.doc = doc;
      this.sourceBlocks = doc.blocks;
      const anchored = preserveLayout && this.pages.wordReflow.eligible();
      await this.draw({preserveLayout});
      if (anchored && !this.popElement) await this.pages.wordReflow.flush({reconcile:true});
      if (this.scope.signal.aborted || generation !== this.generation) return false;
      if (!anchored) await this.restore(anchor, {automatic: true});
      if (this.scope.signal.aborted || generation !== this.generation) return false;
      restoredPosition = pdfBackground;
      return true;
    } finally {
      if (generation === this.generation)
        requestAnimationFrame(() => {
          if (!this.scope.signal.aborted && generation === this.generation) {
            this.restoring = false;
            this.pages.markStable();
            if (restoredPosition) this.emit("position");
          }
        });
    }
  }
  async density(value) {
    const buttons = $$("[data-density]");
    buttons.forEach((b) => (b.disabled = true));
    $("#reader-save").textContent = "正在调整辅助…";
    try {
      await api("/profile", { method: "PATCH", body: { density: value } });
      if (this.scope.signal.aborted) return;
      this.ctx.profile.density = value;
      await this.refresh(value);
      if (!this.scope.signal.aborted)
        $("#reader-save").textContent = "辅助偏好已自动保存";
    } catch (err) {
      if (err.name !== "AbortError") toast(err.message);
    } finally {
      buttons.forEach((b) => (b.disabled = false));
    }
  }
  position() {
    return this.pages?.position() || { ratio: 0 };
  }
  sourceParts(anchor) {
    if (!anchor || (anchor.version !== undefined && anchor.version !== this.doc.version)) return null;
    const parts = anchor.segments?.length ? anchor.segments : [anchor];
    const valid = parts.every(part => {
      const block = this.doc.blocks.find(b => b.id === part.block_id);
      const pdf = part.pdf_source || anchor.pdf_source;
      if (pdf && (!this.doc.pdf ||
          (pdf.source_sha256 && pdf.source_sha256 !== this.doc.pdf.source_sha256) ||
          (pdf.book_id != null && String(pdf.book_id) !== String(this.doc.pdf.book_id)))) return false;
      return block && Number.isInteger(part.start) && Number.isInteger(part.end) &&
        part.start >= 0 && part.end >= part.start && part.end <= block.text.length &&
        (part.version === undefined || part.version === this.doc.version) &&
        (!part.quote || part.quote === block.text.slice(part.start, part.end));
    });
    return valid ? parts : null;
  }
  visibleSource(within = null) {
    const article = $("#article"), parts = within ? this.sourceParts(within) : null;
    if (!article || (within && !parts)) return null;
    const range = document.createRange();
    for (const run of sourceRuns(article)) {
      const id = run.block.dataset.block, block = this.pages.blocks.get(id);
      if (!block || run.node.textContent !== block.text.slice(run.start, run.end)) continue;
      const matches = parts?.filter(p => p.block_id === id &&
        (p.start === p.end ? p.start >= run.start && p.start < run.end : p.start < run.end && p.end > run.start));
      if (parts && !matches.length) continue;
      const parent = run.node.parentElement, leaf = parent.closest(".page-leaf");
      // Moving ink is drawn on a compositor surface; its transparent DOM is
      // source mapping, not proof of visible glyphs at those rectangles.
      if (!leaf || parent.closest(".reflow-moving,[aria-hidden='true']")) continue;
      let left = 0, top = 0, right = innerWidth, bottom = innerHeight, hidden = false;
      for (let node = parent; node; node = node.parentElement) {
        const css = getComputedStyle(node);
        if (css.display === "none" || css.visibility !== "visible" || +css.opacity === 0) { hidden = true; break; }
        const box = node.getBoundingClientRect();
        if (node === leaf || node === article || /hidden|clip|scroll|auto/.test(css.overflowX)) {
          left = Math.max(left, box.left); right = Math.min(right, box.right);
        }
        if (node === leaf || node === article || /hidden|clip|scroll|auto/.test(css.overflowY)) {
          top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
        }
        if (node === article) break;
      }
      if (hidden || right <= left || bottom <= top) continue;
      const color = getComputedStyle(parent).color;
      if (color === "transparent" || /rgba\([^)]*,\s*0\s*\)$/.test(color)) continue;
      for (const match of run.node.textContent.matchAll(/\S/gu)) {
        const start = run.start + match.index, end = start + match[0].length;
        if (matches && !matches.some(p => p.start === p.end
          ? p.start >= start && p.start < end : p.start < end && p.end > start)) continue;
        range.setStart(run.node, match.index); range.setEnd(run.node, match.index + match[0].length);
        for (const box of range.getClientRects()) {
          const x1 = Math.max(left, box.left), x2 = Math.min(right, box.right),
            y1 = Math.max(top, box.top), y2 = Math.min(bottom, box.bottom);
          if (x2 - x1 < .5 || y2 - y1 < .5) continue;
          const hit = document.elementFromPoint((x1 + x2) / 2, (y1 + y2) / 2);
          // The reader's tool veil disables input to the paper (inert) while
          // its glyphs remain visible. Hit testing alone cannot prove occlusion.
          const veil = hit?.matches("#chrome-dismiss,#panel-dismiss") ? getComputedStyle(hit) : null;
          const alpha = veil ? Reader.inputVeilAlpha(veil.backgroundColor) : 1;
          const softVeil = veil && alpha <= .1 && veil.backgroundImage === "none" &&
            veil.filter === "none" && (!veil.backdropFilter || veil.backdropFilter === "none") &&
            veil.boxShadow === "none" && !hit.children.length && !hit.textContent.trim();
          if (hit && (hit === parent || parent.contains(hit) || softVeil))
            return this.anchorFor(id, start, start);
        }
      }
    }
    return null;
  }
  captureView({within} = {}) {
    const copy = value => value ? structuredClone(value) : null;
    return {
      documentId: this.doc.id, sourceVersion: this.doc.version,
      layoutEpoch: this.pages?.layoutEpoch,
      visibleAnchor: this.visibleSource(within),
      readingAnchor: copy(this.position()), selectionAnchor: copy(this.selection),
      // Mounted source ranges can extend beyond the clipped paper. Callers
      // must use visibleAnchor/isAnchorVisible for physical visibility.
      fragments: [...($("#article")?.querySelectorAll("[data-block]") || [])].map(node =>
        ({block_id: node.dataset.block, start: +node.dataset.start, end: +node.dataset.end})),
    };
  }
  isAnchorVisible(anchor) {
    return Boolean(anchor && this.visibleSource(anchor));
  }
  pdfAnchorBlock(anchor, doc = this.doc) {
    if (!doc.pdf || !anchor?.pdf_source) return doc.blocks.find(b => b.id === anchor?.block_id);
    if (anchor.segments?.length) anchor = { ...anchor, ...anchor.segments[0], segments: [] };
    const source = anchor.pdf_source;
    if (source.source_sha256 && source.source_sha256 !== doc.pdf.source_sha256) return null;
    const matches = doc.blocks.filter(b => b.source?.page_number === source.page_number &&
      Array.isArray(source.bbox) && Array.isArray(b.source.bbox) &&
      source.bbox.every((n, i) => Math.abs(n - b.source.bbox[i]) <= .1) &&
      (anchor.version === doc.version || anchor.kind === "image" || !anchor.quote ||
        (b.text.includes(anchor.quote) && b.text.indexOf(anchor.quote) === b.text.lastIndexOf(anchor.quote))));
    return matches.find(b => b.id === anchor.block_id) || (matches.length === 1 ? matches[0] : null);
  }
  async restore(anchor, {automatic = false, mark = true, signal, alignStart = false} = {}) {
    if (signal?.aborted || this.scope.signal.aborted) return false;
    if (automatic && this.handoff) return false;
    let unprovenPosition = false;
    if (automatic && this.doc.pdf && anchor?.pdf_source &&
        anchor.version !== this.doc.version && anchor.kind !== "image") {
      const position = await this.pdfTools?.retainedPosition(anchor);
      if (position === false || signal?.aborted || this.scope.signal.aborted) return false;
      if (position) {
        anchor = position;
        this.resumePositionMapped = true;
      } else unprovenPosition = true;
    }
    if (anchor?.segments?.length) anchor = { ...anchor, ...anchor.segments[0], segments: [] };
    if (this.doc.pdf && anchor?.pdf_source && (unprovenPosition || anchor.pdf_historical || !this.pdfAnchorBlock(anchor))) {
      if (automatic) {
        // OCR may replace regions while keeping the source page. Resume there
        // without treating an approximate position as a relocated quotation.
        const source = anchor.pdf_source;
        const sameSource = (!source.source_sha256 || source.source_sha256 === this.doc.pdf.source_sha256) &&
          (source.book_id == null || String(source.book_id) === String(this.doc.pdf.book_id));
        const block = sameSource && this.doc.blocks.find(b => b.source?.page_number === source.page_number);
        return this.pages.restore(block ? { block_id: block.id, start: 0 } : { ratio: anchor.ratio || 0 }, false, {signal});
      }
      if (!automatic && this.pdfTools) {
        this.pdfTools.openOriginal(anchor.pdf_source);
        this.status("旧引用已保留，已打开对应原页区域。");
      }
      return Promise.resolve(false);
    }
    if (this.doc.pdf && anchor?.pdf_source) {
      const block = this.pdfAnchorBlock(anchor);
      const start = anchor.version !== this.doc.version && anchor.kind !== "image" && anchor.quote
        ? block.text.indexOf(anchor.quote) : anchor.start;
      anchor = {...anchor, block_id: block.id, start,
        end: typeof start === "number" && anchor.quote && anchor.kind !== "image"
          ? start + anchor.quote.length : anchor.end};
    }
    return this.pages.restore(anchor || { ratio: 0 }, mark, {signal, alignStart: alignStart && Boolean(this.pages.validAnchor(anchor))});
  }
  captureSelection() {
    if (this.selecting || this.adjustingSelection || this.aiSetupOpen) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const element = node => node.nodeType === 1 ? node : node.parentElement;
    const image = element(range.startContainer)?.closest("#article [data-pdf-object]");
    if (image && image === element(range.endContainer)?.closest("[data-pdf-object]")) {
      const block = this.doc.blocks.find(b => b.id === image.dataset.block);
      if (block) this.choose(this.anchorFor(block.id, 0, block.text.length), image);
      return;
    }
    let anchor;
    try { anchor = anchorFromDOMRange(this, range); }
    catch (error) { this.clearSelection({native: false}); this.status(error.message); return; }
    if (!anchor?.quote.trim()) return;
    if (sameSelection(this.selection, anchor)) { this.positionSelection(); return; }
    this.choose(anchor);
  }
  closePop() {
    const wasOpen = Boolean(this.popElement);
    this.popScope?.dispose();
    this.popScope = null;
    this.popElement?.remove();
    this.popElement = null;
    this.wordLookupGeneration = (this.wordLookupGeneration || 0) + 1;
    this.positionSelection?.();
    if (wasOpen) this.emit?.("reading-uncovered");
  }
  renderDictionary(pop, item) {
    renderDictionaryCard(pop, {...item, anchor: item.anchor || this.popAnchor});
  }
  pop(el, custom) {
    this.closePop();
    this.wordLookupGeneration = (this.wordLookupGeneration || 0) + 1;
    const selectionMenu = $("#reading-selection");
    if (selectionMenu) selectionMenu.hidden = true;
    const item = custom || this.annotations[+el.dataset.annotation];
    if (!item) return;
    const scope = (this.popScope = new Scope());
    const pop = document.createElement("section");
    this.popElement = pop;
    pop.className = "annotation-pop";
    pop.dataset.annotationSource = item.source || "dictionary";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "注释详情");
    const labels = {
      dictionary: "词典释义 · 请结合上下文",
      model: "AI 注释 · 可核对",
      "context-rule": "本句语境规则",
      "phrase-rule": "常用表达",
      "dictionary-phrase": "表达释义 · 请结合上下文",
      "context-retained": "在这里保留的注释",
    };
    pop.innerHTML = `<header class="word-card-title"><h3>${e(item.text)}</h3><button class="close" aria-label="关闭注释">${actionIcon("close")}</button></header><div class="meta">${e(labels[item.source] || "词典释义")}</div><div class="meaning">${e(item.note || "词典中暂无释义")}</div><details class="word-gloss-detail"><summary>注释补充</summary><p class="muted">${e(item.detail || "通用释义仅供参考，可主动解释此处用法。")}</p></details>${item.target && !this.ctx.enabled("collections") ? '<footer><button data-verdict="known">已掌握 ✓</button><button data-verdict="unknown">保留注释</button></footer>' : ""}`;
    const anchor =
      item.anchor ||
      (item.block
        ? this.anchorFor(item.block.id, item.start, item.end)
        : this.selection);
    this.popAnchor = anchor;
    document.body.append(pop);
    this.renderDictionary(pop, item);
    let frame = 0;
    const place = () => {
      frame = 0;
      if (scope.signal.aborted) return;
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft || 0) + 14;
      const top = (viewport?.offsetTop || 0) + 14;
      const right = left + (viewport?.width || window.innerWidth) - 28;
      const bottom = top + (viewport?.height || window.innerHeight) - 28;
      pop.style.maxHeight = `${Math.max(1, bottom - top)}px`;
      // Pagination may replace the source node when the viewport changes.
      const trigger = el.isConnected
        ? el
        : $$("#article .source-unit").find(
            (unit) =>
              unit.dataset.sourceBlock === anchor?.block_id &&
              +unit.dataset.sourceStart <= anchor.start &&
              +unit.dataset.sourceEnd > anchor.start,
          );
      if (!trigger) return this.closePop();
      const rect = trigger.getBoundingClientRect();
      if (rect.bottom < top || rect.top > bottom) return this.closePop();
      const height = pop.offsetHeight;
      const below = rect.bottom + 12;
      const above = rect.top - height - 12;
      pop.style.left = `${Math.max(left, Math.min(right - pop.offsetWidth, rect.left))}px`;
      pop.style.top = `${Math.max(top, Math.min(bottom - height, below + height <= bottom || above < top ? below : above))}px`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(pop);
    scope.on(this.events, "draw", schedule);
    scope.on(window, "resize", schedule, { passive: true });
    scope.on(window, "scroll", schedule, { passive: true });
    scope.on(document, "scroll", schedule, { passive: true, capture: true });
    scope.on(window.visualViewport, "resize", schedule, { passive: true });
    scope.on(window.visualViewport, "scroll", schedule, { passive: true });
    scope.on(
      pop,
      "wheel",
      (ev) => {
        if (ev.ctrlKey) return;
        const edge =
          ev.deltaY < 0
            ? pop.scrollTop <= 0
            : pop.scrollTop + pop.clientHeight >= pop.scrollHeight - 1;
        if (
          (ev.deltaY && edge) ||
          (ev.deltaX && pop.scrollWidth <= pop.clientWidth + 1)
        )
          ev.preventDefault();
      },
      { passive: false },
    );
    scope.cleanup(() => {
      resize.disconnect();
      cancelAnimationFrame(frame);
    });
    place();
    scope.on($(".close", pop), "click", () => this.closePop());
    scope.on(document, "keydown", (ev) => {
      if (document.querySelector("dialog[open]")) return;
      if (ev.key === "Escape") {
        this.closePop();
        el.focus?.();
      }
    });
    scope.on(document, "pointerdown", (ev) => {
      if (document.querySelector("dialog[open]")) return;
      if (!pop.contains(ev.target) && !el.contains(ev.target)) this.closePop();
    });
    scope.on(pop, "click", async (ev) => {
      const member = ev.target.closest("[data-dictionary-member]");
      if (member && anchor) {
        const start = anchor.start + Number(member.dataset.dictionaryMember);
        const end = start + Number(member.dataset.memberLength);
        const part = this.anchorFor(anchor.block_id, start, end);
        if (part?.quote) await this.lookup(part.quote, el, part);
        return;
      }
      const btn = ev.target.closest("[data-verdict]");
      if (!btn) return;
      $$("footer button", pop).forEach((b) => (b.disabled = true));
      try {
        const feedback = await api("/feedback", {
          method: "POST",
          body: { target: item.target, verdict: btn.dataset.verdict },
        });
        this.closePop();
        await this.refresh(undefined, {preserveLayout: true});
        toast(
          btn.dataset.verdict === "known"
            ? "已记住：减少这项注释"
            : "已记住：保留这项注释",
          {
            label: "撤销",
            run: async () => {
              await api("/feedback", {
                method: "POST",
                body: {
                  target: item.target,
                  verdict: feedback.previous || "reset",
                },
              });
              if (!this.scope.signal.aborted) await this.refresh(undefined, {preserveLayout: true});
            },
          },
        );
      } catch (err) {
        toast(err.message);
        $$("footer button", pop).forEach((b) => (b.disabled = false));
      }
    });
    this.ctx.run("word", { reader: this, pop, item, anchor, scope });
    this.enhancePop(pop, item, anchor, scope).catch((err) => {
      if (err.name !== "AbortError") this.status(err.message);
    });
    $(".close", pop).focus({ preventScroll: true });
  }
  async lookup(word, el, anchor) {
    const generation = this.wordLookupGeneration = (this.wordLookupGeneration || 0) + 1;
    try {
      const result = await api("/lookup", {
        method: "POST",
        body: { word, mark_unknown: false },
        signal: this.scope.signal,
      });
      if (this.scope.signal.aborted || generation !== this.wordLookupGeneration || this.selecting || this.suppressWordClick) return;
      this.lookups++;
      this.pop(el, {
        text: word,
        note: result.note,
        detail: result.detail,
        dictionary: result.dictionary,
        phonetic: result.phonetic,
        target: result.found ? result.lemma : "",
        source: "dictionary",
        anchor,
      });
    } catch (err) {
      if (err.name !== "AbortError") toast(err.message);
    }
  }
}
