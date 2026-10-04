import { $, $$, e, api, Scope, local, toast, errorBox } from "./core.js";
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
    this.ctx.root.innerHTML = `<div class="reader"><div class="reader-bar"><a class="crumb" href="#/">← 书架 / ${e(d.title)}</a><div class="density-control"><span>辅助</span>${[
      [0, "原文"],
      [2, "轻"],
      [4, "适中"],
      [8, "多"],
    ]
      .map(
        ([v, label]) =>
          `<button data-density="${v}" aria-label="辅助密度：${label}" class="${d.density === v ? "active" : ""}">${label}</button>`,
      )
      .join(
        "",
      )}</div><div class="reader-actions" id="reader-actions"></div></div><div class="reader-layout"><section class="reading-sheet"><header class="reading-heading"><div class="eyebrow">${d.chapter ? `CHAPTER ${d.chapter.idx + 1} / ${d.chapters.length}` : "A MOMENT TO READ"}</div><h1>${e(d.title)}</h1><div class="reading-meta"><span>${d.word_count.toLocaleString()} 词</span><span>约 ${Math.max(1, Math.ceil(d.word_count / 180))} 分钟</span><span id="annotation-meta"></span></div></header><article id="article" lang="en" aria-label="英文正文"></article><footer class="reader-foot"><p id="density-hint"></p><div class="row between"><span id="reader-save" role="status">${this.ctx.enabled("progress") ? "阅读位置会自动保存" : "续读已关闭"}</span><div class="row"><button id="archive-reading" class="text-button">${d.archived ? "移回书架" : "归档"}</button><button id="finish-reading" class="text-button">读完了 ✓</button></div></div></footer><div class="reader-end" id="chapter-nav"></div></section><aside class="tool-panel" id="tool-panel" hidden></aside></div><div class="read-progress"><div></div></div></div>`;
    this.draw();
    const s = this.scope;
    s.on($(".density-control"), "click", (ev) => {
      const b = ev.target.closest("[data-density]");
      if (b) this.density(+b.dataset.density);
    });
    s.on($("#article"), "click", (ev) => {
      if (window.getSelection()?.toString()) return;
      const el = ev.target.closest("[data-annotation]");
      if (el) this.pop(el);
    });
    s.on($("#article"), "keydown", (ev) => {
      if (
        (ev.key === "Enter" || ev.key === " ") &&
        ev.target.matches("[data-annotation]")
      ) {
        ev.preventDefault();
        this.pop(ev.target);
      }
    });
    s.on(document, "selectionchange", () => this.captureSelection());
    s.on($("#article"), "dblclick", (ev) => {
      const word = window.getSelection()?.toString().trim();
      if (word && /^[A-Za-z'-]+$/.test(word) && word.length < 60)
        this.lookup(word, ev.target);
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
        toast("阅读已记录，下一篇见。");
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
    if (this.ctx.profile.l1_available)
      this.tool("analyze", "增强注释", async () => {
        try {
          await api(`/documents/${d.id}/analyze`, { method: "POST" });
          toast("增强注释已加入任务");
          this.ctx.navigate("#/jobs");
        } catch (err) {
          toast(err.message);
        }
      });
    s.cleanup(() => {
      this.panelScope?.dispose();
      this.closePop();
      document.body.classList.remove("reading", "immersive");
    });
    if (this.ctx.profile.l1_available) {
      let lastCompleted = 0;
      this.scope.interval(async () => {
        try {
          const jobs = await api("/jobs", { signal: this.scope.signal });
          const related = jobs.filter(
            (j) => j.kind === "annotations" && j.doc_ids.includes(d.id),
          );
          const complete = related.find((j) => j.status === "complete");
          if (complete && complete.id !== lastCompleted) {
            lastCompleted = complete.id;
            await this.refresh();
          }
          const pending = related.find((j) =>
            ["queued", "running"].includes(j.status),
          );
          if (pending && !this.scope.signal.aborted)
            $("#reader-save").textContent = "正在后台补充表达与背景注释…";
        } catch (err) {
          if (err.name !== "AbortError")
            console.warn("Annotation status unavailable");
        }
      }, 3000);
    }
    await this.ctx.run("read", this);
    if (s.signal.aborted) return;
    const selector = local.get(`jump:${d.id}`);
    if (selector) {
      local.remove(`jump:${d.id}`);
      this.restore(selector);
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (s.signal.aborted) return;
        this.restoring = false;
        $(".reader")?.setAttribute("data-ready", "true");
      }),
    );
    local.set("last-document", d.id);
  }
  tool(id, label, fn) {
    const button = document.createElement("button");
    button.id = `tool-${id}`;
    button.textContent = label;
    button.dataset.tool = id;
    button.setAttribute("aria-pressed", "false");
    $("#reader-actions").append(button);
    this.scope.on(button, "click", () =>
      Promise.resolve(fn()).catch((err) => toast(err.message)),
    );
    return button;
  }
  async panel(id, title, html, mount) {
    if (this.panelId === id) {
      this.closePanel();
      return null;
    }
    this.panelScope?.dispose();
    this.panelScope = new Scope();
    const scope = this.panelScope;
    this.panelId = id;
    const el = $("#tool-panel");
    el.innerHTML = `<div class="panel-header"><h2>${e(title)}</h2><button class="icon-button" aria-label="关闭侧栏">×</button></div><div class="panel-content">${html}</div>`;
    el.hidden = false;
    $(".reader-layout").classList.add("has-panel");
    $$("[data-tool]:not([data-toggle])").forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.tool === id)),
    );
    scope.on($(".panel-header button", el), "click", () => this.closePanel());
    try {
      await mount?.($(".panel-content", el), scope);
    } catch (err) {
      if (!scope.signal.aborted) {
        $(".panel-content", el).insertAdjacentHTML("afterbegin", errorBox(err));
      }
    }
    return scope;
  }
  closePanel() {
    this.panelScope?.dispose();
    this.panelScope = null;
    this.panelId = null;
    $("#tool-panel").hidden = true;
    $(".reader-layout").classList.remove("has-panel");
    $$("[data-tool]:not([data-toggle])").forEach((b) =>
      b.setAttribute("aria-pressed", "false"),
    );
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
          if (b) this.restore({ block_id: b.dataset.jump });
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
    this.annotations = [];
    $("#article").innerHTML = this.doc.blocks
      .map((b) => {
        const tag =
          {
            heading: "h2",
            quote: "blockquote",
            code: "pre",
            caption: "p",
            "list-item": "p",
          }[b.type] || "p";
        const text = b.fragments
          .map((f) => {
            if (f.type === "plain") return this.highlight(f.text);
            const idx = this.annotations.push({ ...f, block: b }) - 1;
            return `<span class="annotation" role="button" tabindex="0" data-target="${e(f.target)}" data-kind="${f.kind}" data-annotation="${idx}" aria-label="${e(f.text)}：${e(f.note)}"><span class="source-text">${this.highlight(f.text)}</span><span class="gloss" aria-hidden="true">${e(f.note)}</span></span>`;
          })
          .join("");
        return `<${tag} data-block="${b.id}" class="${b.type === "list-item" ? "list-block" : b.type}">${text}</${tag}>`;
      })
      .join("");
    $("#annotation-meta").textContent =
      `${this.doc.annotation_count} 处辅助理解`;
    $("#density-hint").textContent = this.doc.forced_count
      ? `${this.doc.automatic_count} 处自动辅助 + ${this.doc.forced_count} 处你保留的注释；保留词不会占用自动辅助名额。`
      : this.doc.automatic_count < this.doc.automatic_budget
        ? "当前档位的可用注释已全部显示；‘多’会扩大词汇解释范围。"
        : "点击中文备注可调整熟悉度；双击任意英文词可就地查阅。";
    this.ctx.run("draw", this).catch(console.error);
    $$("[data-density]").forEach((b) => {
      const active = +b.dataset.density === this.doc.density;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
  }
  async refresh(density) {
    if (this.scope.signal.aborted) return;
    const generation = ++this.generation;
    const anchor = this.position();
    this.restoring = true;
    try {
      const doc = await api(
        `/documents/${this.doc.id}${density !== undefined ? "?density=" + density : ""}`,
        { signal: this.scope.signal },
      );
      if (this.scope.signal.aborted || generation !== this.generation) return;
      this.doc = doc;
      this.draw();
      this.restore(anchor);
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
    const article = $("#article");
    if (!article) return { ratio: 0 };
    const threshold = document.body.classList.contains("immersive") ? 90 : 175;
    const rect = article.getBoundingClientRect();
    let visible =
      $$("[data-block]", article).find(
        (el) => el.getBoundingClientRect().bottom > threshold,
      ) || article.lastElementChild;
    if (!visible) return { ratio: 0 };
    const block = this.doc.blocks.find((b) => b.id === visible.dataset.block);
    const r = visible.getBoundingClientRect();
    const fraction = Math.max(
      0,
      Math.min(1, (threshold - r.top) / Math.max(r.height, 1)),
    );
    const start = Math.floor(fraction * block.text.length);
    const ratio = Math.max(
      0,
      Math.min(
        1,
        (threshold - rect.top) /
          Math.max(1, rect.height - window.innerHeight + threshold + 70),
      ),
    );
    return {
      version: this.doc.version,
      block_id: block.id,
      start,
      end: start,
      quote: block.text.slice(start, start + 60),
      prefix: block.text.slice(Math.max(0, start - 40), start),
      suffix: "",
      ratio,
    };
  }
  restore(anchor) {
    let block = this.doc.blocks.find((b) => b.id === anchor.block_id);
    let start = anchor.start || 0;
    if (!block && anchor.quote) {
      block = this.doc.blocks.find((b) => b.text.includes(anchor.quote));
      if (block) start = block.text.indexOf(anchor.quote);
    }
    const element = block && $(`[data-block="${block.id}"]`);
    const threshold = document.body.classList.contains("immersive") ? 90 : 175;
    if (element) {
      const r = element.getBoundingClientRect();
      window.scrollTo({
        top: Math.max(
          0,
          window.scrollY +
            r.top -
            threshold +
            Math.min(1, start / Math.max(1, block.text.length)) * r.height,
        ),
        behavior: "instant",
      });
      element.classList.remove("anchor-flash");
      void element.offsetWidth;
      element.classList.add("anchor-flash");
    } else if (anchor.ratio) {
      const a = $("#article");
      window.scrollTo({
        top:
          window.scrollY +
          a.getBoundingClientRect().top +
          (a.offsetHeight - window.innerHeight) * anchor.ratio,
        behavior: "instant",
      });
    }
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
    if (!startEl || startEl !== endEl) return;
    const strip = (fragment) => {
      fragment
        .querySelectorAll?.(".gloss,.bookmark-marker")
        .forEach((el) => el.remove());
      return fragment.textContent;
    };
    const before = document.createRange();
    before.selectNodeContents(startEl);
    before.setEnd(range.startContainer, range.startOffset);
    const start = strip(before.cloneContents()).length;
    const quote = strip(range.cloneContents()).trim();
    if (!quote) return;
    const block = this.doc.blocks.find((b) => b.id === startEl.dataset.block);
    const exact = block.text.indexOf(quote, Math.max(0, start - 2));
    const offset = exact >= 0 ? exact : start;
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
    document.body.append(pop);
    const rect = el.getBoundingClientRect();
    pop.style.left = `${Math.max(14, Math.min(window.innerWidth - pop.offsetWidth - 14, rect.left))}px`;
    pop.style.top = `${Math.max(14, Math.min(window.innerHeight - pop.offsetHeight - 20, rect.bottom + 12))}px`;
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
    $(".close", pop).focus({ preventScroll: true });
  }
  async lookup(word, el) {
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
      });
    } catch (err) {
      if (err.name !== "AbortError") toast(err.message);
    }
  }
}
