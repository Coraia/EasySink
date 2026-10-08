import { $, $$, e, api, local, date, toast } from "../core.js";
import { noteStore } from "./notes-store.js?v=20261005-open3";
const pencil =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11l3 3v15H5zM8 8h8M8 12h8M8 16h5"/></svg>';
export function install(ctx) {
  const read = ctx.hook("read", async (reader) => {
    await new ReaderNotes(reader).mount();
  });
  const route = ctx.route("notes", async (scope) => {
    const notes = await api("/notes", { signal: scope.signal });
    if (scope.signal.aborted) return;
    ctx.root.innerHTML = `<div class="page"><div class="page-head"><div><div class="eyebrow">THOUGHTS WORTH KEEPING</div><h1>读过，也想过。</h1><p>${notes.length} 条笔记，留住阅读中的联想。</p></div>${ctx.enabled("export") ? '<a class="button" href="/api/export/notes.md" download>导出 Markdown ↗</a>' : ""}</div><input type="search" id="notes-search" placeholder="搜索笔记与原句…" aria-label="搜索笔记"><section id="notes-list" class="card gap"></section></div>`;
    const draw = () => {
      const q = $("#notes-search").value.toLowerCase();
      $("#notes-list").innerHTML =
        notes
          .filter((n) => (n.body + n.quote + n.title).toLowerCase().includes(q))
          .map(
            (n) =>
              `<div class="list-item"><div class="row between"><span class="meta">${e(n.title)} · ${date(n.created_at)}</span><button class="text-button" data-delete-note="${n.id}" aria-label="删除笔记">删除</button></div>${n.quote ? `<blockquote>${e(n.quote)}</blockquote>` : ""}<p class="body">${e(n.body)}</p><button class="text-button" data-jump-note="${n.id}">回到这段原文 →</button></div>`,
          )
          .join("") ||
        '<div class="empty">阅读时打开“笔记”，选中原文写下想法。</div>';
    };
    draw();
    scope.on($("#notes-search"), "input", draw);
    scope.on($("#notes-list"), "click", async (ev) => {
      const jump = ev.target.closest("[data-jump-note]"),
        del = ev.target.closest("[data-delete-note]");
      if (jump) {
        const n = notes.find((n) => n.id === +jump.dataset.jumpNote);
        ctx.jump(n.doc_id, n.anchor || { quote: n.quote });
      }
      if (del) {
        const n = notes.find((n) => n.id === +del.dataset.deleteNote);
        del.disabled = true;
        try {
          const removed = await noteStore.remove(n);
          notes.splice(notes.indexOf(n), 1);
          if (local.get(`note-draft:${n.doc_id}`)?.id === n.id)
            local.remove(`note-draft:${n.doc_id}`);
          draw();
          toast("笔记已删除", {
            label: "撤销",
            run: async () => {
              await noteStore.undo(removed);
              ctx.refresh();
            },
          });
        } catch (err) {
          toast(err.message);
          del.disabled = false;
        }
      }
    });
  });
  return () => {
    read();
    route();
  };
}

class ReaderNotes {
  constructor(reader) {
    this.r = reader;
    this.notes = [];
    this.filter = "book";
    this.book = reader.doc.chapter?.book_id;
    this.ids = this.book
      ? reader.doc.chapters.map((c) => c.doc_id)
      : [reader.doc.id];
    this.applied = new Map();
    this.blocks = new Map(reader.doc.blocks.map((b) => [b.id, b]));
    this.noteIndex = null;
    this.deleting = new Set();
  }
  async mount() {
    const r = this.r;
    r.tool("notes", "笔记", () => this.list());
    r.selectionAction("notes", "记一笔", () => {
      if (r.selection) this.fresh({ ...r.selection });
    });
    this.back = document.createElement("button");
    this.back.className = "text-button note-return";
    this.back.textContent = "回到刚才";
    this.back.hidden = true;
    $(".reader-page-caption").append(this.back);
    r.scope.on(this.back, "click", () => this.returnToSource());
    r.scope.cleanup(noteStore.subscribe((entry) => this.changed(entry)));
    r.on("draw", () => this.paint());
    r.scope.on($("#article"), "click", (ev) => {
      const marker = ev.target.closest("[data-open-note-block]");
      if (marker) {
        ev.stopPropagation();
        this.preview(
          marker.dataset.openNoteBlock,
          marker.getBoundingClientRect(),
        );
      }
    });
    r.scope.cleanup(() => {
      CSS.highlights?.delete("reader-notes");
      this.back.remove();
    });
    await this.reload();
    if (r.scope.signal.aborted) return;
    noteStore.migrate(r.doc.id, this.notes);
    const origin = local.get("note-return");
    if (origin) {
      this.origin = origin;
      this.back.hidden = false;
    }
    this.badge();
  }
  async reload() {
    this.notes = await api(
      this.book
        ? `/notes?book_id=${this.book}`
        : `/notes?doc_id=${this.r.doc.id}`,
      { signal: this.r.scope.signal },
    );
    if (!this.r.scope.signal.aborted) {
      this.noteIndex = null;
      this.paint();
      this.badge();
    }
  }
  drafts() {
    return noteStore.drafts(this.ids);
  }
  badge() {
    const button = $("#tool-notes");
    if (!button || this.r.scope.signal.aborted) return;
    $(".note-count", button)?.remove();
    const drafts = this.drafts().length;
    const label = `笔记 · ${this.notes.length} 条${drafts ? ` · ${drafts} 条草稿` : ""}`;
    button.setAttribute("aria-label", label);
    button.title = label;
    if (this.notes.length || drafts)
      button.insertAdjacentHTML(
        "beforeend",
        `<span class="note-count ${drafts ? "has-draft" : ""}" aria-hidden="true">${this.notes.length || "·"}</span>`,
      );
  }
  changed(entry) {
    if (this.r.scope.signal.aborted) return;
    if (
      entry?.saved &&
      this.ids.includes(entry.doc_id) &&
      this.applied.get(entry.client_id) !== entry.savedBody
    ) {
      this.applied.set(entry.client_id, entry.savedBody);
      const i = this.notes.findIndex((n) => n.id === entry.id);
      const saved = { ...(i >= 0 ? this.notes[i] : {}), ...entry.saved };
      if (entry.doc_id === this.r.doc.id) saved.title = this.r.doc.title;
      if (i >= 0) this.notes[i] = saved;
      else this.notes.push(saved);
      this.noteIndex = null;
      this.paint();
      this.r.pages?.invalidatePaint();
    }
    this.badge();
    if (this.editor === entry) this.saveState(entry);
    if (this.r.panelId === "notes" && !this.editor) this.drawList();
  }
  resolved(n) {
    if (n.doc_id !== this.r.doc.id || !n.quote) return null;
    let block = this.blocks.get(n.anchor?.block_id);
    let start = n.anchor?.start || 0,
      end = n.anchor?.end || start + n.quote.length;
    if (!block || block.text.slice(start, end) !== n.quote) {
      block = this.r.doc.blocks.find((b) => b.text.includes(n.quote));
      if (!block) return null;
      start = block.text.indexOf(n.quote);
      end = start + n.quote.length;
    }
    return { ...n.anchor, block_id: block.id, start, end, quote: n.quote };
  }
  paint() {
    if (this.r.scope.signal.aborted) return;
    $$("#article .note-marker").forEach((el) => el.remove());
    $$("#article .source-unit.has-note").forEach((el) =>
      el.classList.remove("has-note"),
    );
    if (!this.noteIndex) {
      this.noteIndex = new Map();
      for (const note of this.notes) {
        const anchor = this.resolved(note);
        if (!anchor) continue;
        if (!this.noteIndex.has(anchor.block_id))
          this.noteIndex.set(anchor.block_id, []);
        this.noteIndex.get(anchor.block_id).push(anchor);
      }
    }
    const byBlock = this.noteIndex,
      ranges = [];
    $$("#article [data-block]").forEach((el) => {
      const anchors = (byBlock.get(el.dataset.block) || []).filter(
        (a) => a.start < +el.dataset.end && a.end > +el.dataset.start,
      );
      if (!anchors.length) return;
      const marker = document.createElement("button"),
        count = byBlock.get(el.dataset.block).length;
      marker.className = "note-marker";
      marker.dataset.openNoteBlock = el.dataset.block;
      marker.setAttribute("aria-label", `查看这段的${count}条笔记`);
      marker.title = marker.getAttribute("aria-label");
      marker.innerHTML = pencil + (count > 1 ? `<span>${count}</span>` : "");
      el.closest(".source-row").append(marker);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node,
        offset = +el.dataset.start;
      while ((node = walker.nextNode())) {
        if (node.parentElement.closest(".gloss,.bookmark-marker")) continue;
        const end = offset + node.textContent.length;
        for (const a of anchors)
          if (offset < a.end && end > a.start) {
            const range = document.createRange();
            range.setStart(node, Math.max(0, a.start - offset));
            range.setEnd(
              node,
              Math.min(node.textContent.length, a.end - offset),
            );
            ranges.push(range);
            node.parentElement
              .closest(".source-unit")
              ?.classList.add("has-note");
          }
        offset = end;
      }
    });
    if (CSS.highlights && globalThis.Highlight)
      CSS.highlights.set("reader-notes", new Highlight(...ranges));
  }
  location(n) {
    if (!n.quote) return this.book ? "全书随记" : "篇章随记";
    const block = this.r.doc.blocks.find((b) => b.id === n.anchor?.block_id);
    const heading =
      block &&
      this.r.doc.blocks
        .slice(0, this.r.doc.blocks.indexOf(block) + 1)
        .filter((b) => b.type === "heading")
        .at(-1);
    return n.chapter_title || heading?.text || n.title || this.r.doc.title;
  }
  card(n) {
    return `<article class="reader-note-item" data-note-id="${n.id}">${n.quote ? `<button class="note-excerpt" data-note-jump="${n.id}" title="回到这段原文">${e(n.quote)}</button>` : ""}<p class="note-thought">${e(n.body)}</p><div class="note-item-actions"><span class="meta">${e(this.location(n))}</span><button class="text-button" data-note-edit="${n.id}">编辑</button><button class="icon-button" data-note-more="${n.id}" aria-label="笔记更多操作" aria-expanded="false">⋯</button></div><div data-note-delete-zone="${n.id}" hidden><button class="text-button note-danger" data-note-delete="${n.id}">删除笔记</button></div></article>`;
  }
  currentChapter(n) {
    if (!n.quote || n.doc_id !== this.r.doc.id) return false;
    if (this.book) return true;
    const chapterAt = (anchor) => {
      const i = this.r.doc.blocks.findIndex((b) => b.id === anchor?.block_id);
      return this.r.doc.blocks
        .slice(0, i + 1)
        .filter((b) => b.type === "heading")
        .at(-1)?.id;
    };
    return chapterAt(this.resolved(n)) === chapterAt(this.r.position());
  }
  drawList(force = false) {
    const el = $("#notes-content");
    if (!el || this.r.panelId !== "notes") return;
    const expanded = $$("[data-note-delete-zone]", el)
      .filter((v) => !v.hidden)
      .map((v) => v.dataset.noteDeleteZone);
    // Don't move a user's open delete target when a background draft completes.
    if (expanded.length && !force) return;
    const blockIndex = (n) =>
      this.r.doc.blocks.findIndex((b) => b.id === n.anchor?.block_id);
    const notes = this.notes
      .filter((n) => this.filter === "book" || this.currentChapter(n))
      .sort(
        (a, b) =>
          (a.chapter_idx || 0) - (b.chapter_idx || 0) ||
          blockIndex(a) - blockIndex(b) ||
          (a.anchor?.start || 0) - (b.anchor?.start || 0) ||
          a.id - b.id,
      );
    el.innerHTML = `<div class="notes-list-controls"><button class="text-button" data-note-filter="book" aria-pressed="${this.filter === "book"}">${this.book || this.r.doc.blocks.some((b) => b.type === "heading") ? "这本书" : "本篇"}</button><button class="text-button" data-note-filter="chapter" aria-pressed="${this.filter === "chapter"}">当前章</button><button class="text-button" data-note-journal>＋ 写随记</button></div>${this.drafts()
      .map(
        (d) =>
          `<div class="note-draft-row"><span class="meta">未保存草稿 · ${e(this.location(d))}</span><button class="text-button" data-note-resume="${e(d.client_id)}">继续</button><button class="text-button" data-note-discard="${e(d.client_id)}">丢弃</button></div>`,
      )
      .join(
        "",
      )}${notes.map((n) => this.card(n)).join("") || '<div class="empty">还没有笔记。<br>选中原文，记下你的想法。</div>'}<p class="muted note-list-help">点原句回到原文，点“编辑”修改想法。</p>`;
    $("#tool-panel .panel-header h2").textContent =
      `阅读笔记 · ${this.notes.length}`;
    for (const id of expanded) {
      const zone = $(`[data-note-delete-zone="${id}"]`, el);
      if (zone) {
        zone.hidden = false;
        $(`[data-note-more="${id}"]`, el).setAttribute("aria-expanded", "true");
      }
    }
    for (const id of this.deleting) {
      const b = $(`[data-note-delete="${id}"]`, el);
      if (b) b.disabled = true;
    }
  }
  list() {
    return this.r.panel(
      "notes",
      "阅读笔记",
      '<div id="notes-content"></div>',
      (el, scope) => {
        this.drawList();
        scope.on(el, "click", (ev) => {
          this.cardAction(ev, "list");
          const b = ev.target.closest("button");
          if (!b) return;
          if (b.dataset.noteFilter) {
            this.filter = b.dataset.noteFilter;
            this.drawList();
          }
          if (b.hasAttribute("data-note-journal")) this.fresh(null, "list");
          if (b.dataset.noteResume) {
            const d = this.drafts().find(
              (d) => d.client_id === b.dataset.noteResume,
            );
            if (d) this.edit(d, "list");
          }
          if (b.dataset.noteDiscard) {
            const d = this.drafts().find(
              (d) => d.client_id === b.dataset.noteDiscard,
            );
            if (d)
              noteStore.discard(d).then(() => {
                this.drawList();
                this.badge();
              });
          }
        });
      },
    );
  }
  sourceRect(anchor) {
    const ranges = this.r.selectedTextRanges || [];
    if (this.r.selection?.block_id === anchor?.block_id && ranges.length)
      return ranges.at(-1).range.getBoundingClientRect();
    return $$("#article [data-block]")
      .find(
        (el) =>
          el.dataset.block === anchor?.block_id &&
          +el.dataset.start <= anchor.start &&
          +el.dataset.end > anchor.start,
      )
      ?.getBoundingClientRect();
  }
  floating(scope, rect) {
    const panel = $("#tool-panel");
    panel.classList.add("note-floating");
    const place = () => {
      const safe = this.r.focus.isOpen() ? 76 : 12,
        box = panel.getBoundingClientRect();
      let top = (rect?.bottom || 64) + 10;
      if (top + box.height > innerHeight - safe)
        top = Math.max(
          safe,
          (rect?.top || innerHeight - safe) - box.height - 10,
        );
      panel.style.left =
        Math.max(
          12,
          Math.min(
            rect?.left || (innerWidth - box.width) / 2,
            innerWidth - box.width - 12,
          ),
        ) + "px";
      panel.style.top =
        Math.max(safe, Math.min(top, innerHeight - safe - box.height)) + "px";
    };
    place();
    scope.on(window, "resize", place);
    scope.cleanup(() => {
      panel.classList.remove("note-floating");
      panel.style.left = "";
      panel.style.top = "";
    });
    return place;
  }
  preview(block_id, rect) {
    const notes = this.notes.filter(
      (n) => this.resolved(n)?.block_id === block_id,
    );
    this.r.panel(
      "note-preview",
      `这段的笔记 · ${notes.length}`,
      notes.map((n) => this.card(n)).join("") +
        '<button class="text-button" data-note-add>＋ 再记一笔</button>',
      (el, scope) => {
        this.floating(scope, rect);
        scope.on(el, "click", (ev) => {
          this.cardAction(ev, "source");
          if (ev.target.closest("[data-note-add]")) {
            const b = this.r.doc.blocks.find((b) => b.id === block_id);
            this.fresh(
              this.r.anchorFor(block_id, 0, Math.min(b.text.length, 10000)),
            );
          }
        });
      },
    );
  }
  fresh(anchor, origin = "source") {
    this.edit(
      {
        doc_id: this.r.doc.id,
        book_id: this.book,
        quote: anchor?.quote || "",
        anchor,
        client_id: crypto.randomUUID(),
        body: "",
      },
      origin,
    );
  }
  edit(note, origin) {
    if (origin === "source" && note.anchor)
      this.r.choose(this.resolved(note) || note.anchor);
    const rect = this.sourceRect(note.anchor),
      entry = noteStore.entry(note);
    if (this.drafts().some((d) => d.client_id === entry.client_id)) {
      if (entry.state === "idle") entry.state = "draft";
      entry.durable = true;
    }
    if (origin === "source") this.r.focus.close();
    if (this.r.panelId === "notes") this.r.closePanel();
    this.r.panel(
      "notes",
      note.id ? "编辑笔记" : note.quote ? "记一笔" : "写随记",
      `${origin === "list" ? '<button class="text-button" id="note-back">← 返回笔记列表</button>' : ""}<span class="meta">${e(this.location(note))}</span>${entry.quote ? `<button class="note-excerpt note-editor-quote" id="note-quote" aria-expanded="false" title="展开引用">${e(entry.quote)}</button>` : ""}<label for="note-body">我的想法</label><textarea id="note-body" rows="3" placeholder="写下此刻的想法…">${e(entry.body)}</textarea><div class="note-editor-footer"><span id="note-state" class="save-state" role="status"></span><button id="note-retry" class="text-button" hidden>重试</button><button id="note-done">完成</button></div>`,
      (el, scope) => {
        this.editor = entry;
        const panel = $("#tool-panel");
        panel.classList.add("note-editor");
        const place =
          origin === "source" ? this.floating(scope, rect) : () => {};
        const textarea = $("#note-body", el);
        const fit = () => {
          textarea.style.height = "auto";
          textarea.style.height =
            Math.min(220, Math.max(90, textarea.scrollHeight)) + "px";
          place();
        };
        scope.on(textarea, "input", () => {
          noteStore.change(entry, textarea.value);
          fit();
        });
        scope.on($("#note-quote", el), "click", (ev) => {
          const b = ev.currentTarget;
          b.classList.toggle("expanded");
          b.setAttribute(
            "aria-expanded",
            String(b.classList.contains("expanded")),
          );
          place();
        });
        const finish = () => this.r.dismissPanel();
        scope.on($("#note-done", el), "click", finish);
        scope.on($("#note-back", el), "click", finish);
        scope.on($("#note-retry", el), "click", () => {
          entry.state = "saving";
          this.saveState(entry);
          noteStore.save(entry);
        });
        scope.on(window, "pagehide", () => noteStore.save(entry));
        scope.on(window, "online", () => noteStore.save(entry));
        scope.cleanup(() => {
          this.editor = null;
          panel.classList.remove("note-editor");
          noteStore.finish(entry);
        });
        this.saveState(entry);
        fit();
        textarea.focus({ preventScroll: true });
      },
      { onClose: origin === "list" ? () => this.list() : undefined },
    );
  }
  saveState(entry) {
    const state = $("#note-state");
    if (!state) return;
    const text = {
      idle: entry.id ? "已保存 · 修改后自动保存" : "写下想法后自动保存",
      draft: "未保存草稿 · 可继续编辑",
      saving: "保存中…",
      saved: "已保存到本机 ✓",
      empty: entry.id ? "内容为空，原笔记保留" : "写下想法后自动保存",
      failed: entry.durable ? "保存失败 · 草稿已保留" : "保存失败 · 请复制内容",
    };
    state.textContent = text[entry.state];
    state.title = entry.error || "";
    state.classList.toggle("note-danger", entry.state === "failed");
    $("#note-retry").hidden = !["failed", "draft"].includes(entry.state);
  }
  cardAction(ev, origin) {
    const b = ev.target.closest("button");
    if (!b) return;
    const id = +(
        b.dataset.noteJump ||
        b.dataset.noteEdit ||
        b.dataset.noteDelete ||
        b.dataset.noteMore
      ),
      n = this.notes.find((n) => n.id === id);
    if (b.dataset.noteMore) {
      const zone = $(
        `[data-note-delete-zone="${id}"]`,
        b.closest(".reader-note-item"),
      );
      zone.hidden = !zone.hidden;
      b.setAttribute("aria-expanded", String(!zone.hidden));
      if (zone.hidden) this.drawList();
    }
    if (b.dataset.noteJump && n) this.jump(n);
    if (b.dataset.noteEdit && n) this.edit(n, origin);
    if (b.dataset.noteDelete && n) this.remove(n, b);
  }
  async remove(note, button) {
    if (this.deleting.has(String(note.id))) return;
    this.deleting.add(String(note.id));
    button.disabled = true;
    try {
      const removed = await noteStore.remove(note);
      this.notes = this.notes.filter((n) => n.id !== note.id);
      this.noteIndex = null;
      this.paint();
      this.badge();
      this.r.pages.invalidatePaint();
      if (this.r.panelId === "notes") this.drawList(true);
      else this.r.closePanel();
      toast("笔记已删除", {
        label: "撤销",
        run: async () => {
          await noteStore.undo(removed);
          if (!this.r.scope.signal.aborted) {
            await this.reload();
            this.drawList();
            this.r.pages.invalidatePaint();
          }
        },
      });
    } catch (err) {
      toast(err.message);
      button.disabled = false;
    } finally {
      this.deleting.delete(String(note.id));
      this.drawList();
    }
  }
  async jump(note) {
    const anchor = this.resolved(note) || note.anchor || { quote: note.quote };
    this.origin ||= { doc_id: this.r.doc.id, anchor: this.r.position() };
    this.r.returnAnchor =
      this.origin.doc_id === this.r.doc.id ? this.origin.anchor : null;
    local.set("note-return", this.origin);
    this.r.focus.close();
    this.r.selection = null;
    if (note.doc_id !== this.r.doc.id) this.r.ctx.jump(note.doc_id, anchor);
    else {
      await this.r.restore(anchor);
      this.back.hidden = false;
    }
  }
  async returnToSource() {
    const origin = this.origin;
    if (!origin) return;
    this.origin = null;
    local.remove("note-return");
    this.back.hidden = true;
    this.r.returnAnchor = null;
    if (origin.doc_id !== this.r.doc.id)
      this.r.ctx.jump(origin.doc_id, origin.anchor);
    else await this.r.restore(origin.anchor);
  }
}
