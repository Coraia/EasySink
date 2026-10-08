import { $, $$, e, api, Scope, local, toast, errorBox } from "./core.js";
import { ReadingPages } from "./pagination.js?v=20261008-paper";
import { setupReadingInteractions } from "./reading-interactions.js?v=20261006-grab1";
import { installReadingTraces } from "./reading-traces.js";
import {
  readerShell,
  installReaderChrome,
  installCoreReaderTools,
  readerIcon,
} from "./reader-chrome.js?v=20261006-grab1";
export class Reader {
  constructor(ctx, scope, doc) {
    this.ctx = ctx;
    this.scope = scope;
    this.doc = doc;
    this.generation = 0;
    this.lookups = 0;
    this.panelScope = null;
    this.panelId = null;
    this.search = "";
    this.selection = null;
    this.restoring = true;
  }
  async mount() {
    const d = this.doc;
    document.body.classList.add("reading");
    $("#header-context").textContent = d.title;
    document.body.classList.add("paged-reading");
    this.ctx.root.innerHTML = readerShell(d, this.ctx.enabled("progress"));
    installReaderChrome(this);
    setupReadingInteractions(this);
    this.pages = new ReadingPages(this);
    await this.draw();
    const s = this.scope;
    s.on($(".density-control"), "click", (ev) => {
      const b = ev.target.closest("[data-density]");
      if (b) this.density(+b.dataset.density);
    });
    s.on($("#article"), "click", (ev) => {
      if (window.getSelection()?.toString()) return;
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
    s.on($("#article"), "dblclick", (ev) => {
      const word = window.getSelection()?.toString().trim();
      if (word && /^[A-Za-z'-]+$/.test(word) && word.length < 60)
        this.lookup(word, ev.target, this.selection);
    });
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
      $("#chapter-nav").innerHTML = d.chapters
        .map((ch, i) =>
          Math.abs(i - d.chapter.idx) === 1
            ? `<a class="button" href="#/read/${ch.doc_id}">${i < d.chapter.idx ? "← 上一章" : "下一章 →"}</a>`
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
    const selector = local.get(`jump:${d.id}`);
    if (selector) {
      local.remove(`jump:${d.id}`);
      await this.restore(selector);
    }
    const translationJump = local.get(`translation-jump:${d.id}`);
    if (translationJump) {
      local.remove(`translation-jump:${d.id}`);
      const saved = this.assists.find((a) => a.id === translationJump);
      if (saved) this.showTranslation?.(saved);
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (s.signal.aborted) return;
        this.restoring = false;
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
    this.positionSelection?.();
    $("#tool-panel").hidden = true;
    $("#panel-dismiss").hidden = true;

    $$("#reader-actions [data-tool]").forEach((b) => {
      b.setAttribute("aria-pressed", "false");
      b.setAttribute("aria-expanded", "false");
    });
  }
  outline() {
    this.panel(
      "outline",
      "阅读目录",
      this.doc.chapters.length
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
            '<p class="muted">这是一篇短文，可以直接从头阅读。</p>',
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
  draw() {
    this.pages.indexSource();
    const ready = this.pages.reflow(this.pages.position());
    $("#annotation-meta").textContent =
      `${this.doc.annotation_count} 处辅助理解`;
    $("#density-hint").textContent = this.doc.forced_count
      ? `${this.doc.automatic_count} 处自动辅助 + ${this.doc.forced_count} 处你保留的注释；保留词不会占用自动辅助名额。`
      : this.doc.automatic_count < this.doc.automatic_budget
        ? "当前档位的可用注释已全部显示；‘多’会扩大词汇解释范围。"
        : "点击中文备注可调整熟悉度；双击任意英文词可就地查阅。";

    $$("[data-density]").forEach((b) => {
      const active = +b.dataset.density === this.doc.density;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
    return ready;
  }
  async refresh(density) {
    if (this.scope.signal.aborted) return;
    const generation = ++this.generation;
    const anchor = this.position();
    this.restoring = true;
    try {
      const doc = await api(
        `/documents/${this.doc.id}?compact=true${density !== undefined ? "&density=" + density : ""}`,
        { signal: this.scope.signal },
      );
      if (this.scope.signal.aborted || generation !== this.generation) return;
      this.doc = doc;
      await this.draw();
      await this.restore(anchor);
    } finally {
      if (generation === this.generation)
        requestAnimationFrame(() => (this.restoring = false));
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
  restore(anchor) {
    return this.pages.restore(anchor || { ratio: 0 });
  }
  captureSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const startEl = (
      range.startContainer.nodeType === 1
        ? range.startContainer
        : range.startContainer.parentElement
    )?.closest("[data-block]");
    const endEl = (
      range.endContainer.nodeType === 1
        ? range.endContainer
        : range.endContainer.parentElement
    )?.closest("[data-block]");
    if (!startEl || !endEl) return;
    if (startEl !== endEl) {
      this.emit("before-selection");
      for (const controller of this.pending.values()) controller.cancel();
      this.pending.clear();
      this.selection = null;
      this.renderSelection();
      this.status("请在同一段内选择原文；跨段选择未用于翻译或分析。");
      return;
    }
    const strip = (fragment) => {
      fragment
        .querySelectorAll?.(".gloss,.bookmark-marker")
        .forEach((el) => el.remove());
      return fragment.textContent;
    };
    const before = document.createRange();
    before.selectNodeContents(startEl);
    before.setEnd(range.startContainer, range.startOffset);
    const start = +startEl.dataset.start + strip(before.cloneContents()).length;
    const quote = strip(range.cloneContents()).trim();
    if (!quote) return;
    const block = this.doc.blocks.find((b) => b.id === startEl.dataset.block);
    const exact = block.text.indexOf(quote, Math.max(0, start - 2));
    const offset = exact >= 0 ? exact : start;
    this.emit("before-selection");
    this.selection = {
      version: this.doc.version,
      block_id: block.id,
      start: offset,
      end: offset + quote.length,
      quote: quote.slice(0, 10000),
      prefix: block.text.slice(Math.max(0, offset - 40), offset),
      suffix: block.text.slice(
        offset + quote.length,
        offset + quote.length + 40,
      ),
      ratio: this.position().ratio,
    };
    this.selectionPlacement = {
      block_id: block.id,
      offset: offset + quote.length,
      trigger: "range",
    };
    this.renderSelection();
    this.ctx.run("selection", this).catch(console.error);
  }
  closePop() {
    this.popScope?.dispose();
    this.popScope = null;
    this.popElement?.remove();
    this.popElement = null;
  }
  pop(el, custom) {
    this.closePop();
    const item = custom || this.annotations[+el.dataset.annotation];
    if (!item) return;
    const scope = (this.popScope = new Scope());
    const pop = document.createElement("section");
    this.popElement = pop;
    pop.className = "annotation-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", "注释详情");
    const labels = {
      dictionary: "词典释义 · 请结合上下文",
      model: "AI 注释 · 可核对",
      "context-rule": "本句语境规则",
      "phrase-rule": "常用表达",
    };
    pop.innerHTML = `<button class="close" aria-label="关闭注释">×</button><div class="meta">${e(labels[item.source] || "词典释义")}</div><h3>${e(item.text)}</h3><div class="meaning">${e(item.note || "词典中暂无释义")}</div><p class="muted">${e(item.detail || "选择“已掌握”后，会减少这项注释。")}</p>${item.target ? '<footer><button data-verdict="known">已掌握 ✓</button><button data-verdict="unknown">保留注释</button></footer>' : ""}`;
    const anchor =
      item.anchor ||
      (item.block
        ? this.anchorFor(item.block.id, item.start, item.end)
        : this.selection);
    this.popAnchor = anchor;
    document.body.append(pop);
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
      if (ev.key === "Escape") {
        this.closePop();
        el.focus?.();
      }
    });
    scope.on(document, "pointerdown", (ev) => {
      if (!pop.contains(ev.target) && !el.contains(ev.target)) this.closePop();
    });
    scope.on(pop, "click", async (ev) => {
      const btn = ev.target.closest("[data-verdict]");
      if (!btn) return;
      $$("footer button", pop).forEach((b) => (b.disabled = true));
      try {
        const feedback = await api("/feedback", {
          method: "POST",
          body: { target: item.target, verdict: btn.dataset.verdict },
        });
        this.closePop();
        await this.refresh();
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
              if (!this.scope.signal.aborted) await this.refresh();
            },
          },
        );
      } catch (err) {
        toast(err.message);
        $$("footer button", pop).forEach((b) => (b.disabled = false));
      }
    });
    this.enhancePop(pop, item, anchor, scope).catch((err) => {
      if (err.name !== "AbortError") this.status(err.message);
    });
    $(".close", pop).focus({ preventScroll: true });
  }
  async lookup(word, el, anchor) {
    try {
      const result = await api("/lookup", {
        method: "POST",
        body: { word, mark_unknown: false },
        signal: this.scope.signal,
      });
      if (this.scope.signal.aborted) return;
      this.lookups++;
      this.pop(el, {
        text: word,
        note: result.note,
        detail: result.detail,
        target: result.found ? result.lemma : "",
        source: "dictionary",
        anchor,
      });
    } catch (err) {
      if (err.name !== "AbortError") toast(err.message);
    }
  }
}
