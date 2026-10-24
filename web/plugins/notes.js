import { anchorSegments, combineSelection, sourceExcerpt, sameSelection } from "../source-selection.js";
import { $, $$, e, api, local, date, toast, Scope } from "../core.js";
import { noteStore, imageReference } from "./notes-store.js?v=20261008-pdf";
const pencil =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11l3 3v15H5zM8 8h8M8 12h8M8 16h5"/></svg>';
function imageExcerpt(note, attrs = "") {
  const image = imageReference(note);
  if (!image) return "";
  return `<button class="note-excerpt pdf-note-excerpt" ${attrs}>${image.asset_url ? `<img src="${e(image.asset_url)}" alt="保留的原图引用" loading="lazy">` : '<span class="pdf-note-missing">原图预览暂不可用</span>'}<span>${e(image.label)}</span></button>`;
}
export function imageAnchor(reader, block) {
  if (
    !reader.doc.pdf ||
    !Number.isInteger(block?.source?.page_number) ||
    !Array.isArray(block.source.bbox) ||
    block.source.bbox.length !== 4
  )
    return null;
  const anchor = reader.anchorFor(block.id, 0, block.text?.length || 1);
  if (!anchor) return null;
  const source = structuredClone(block.source);
  if (source.conversion_task_id == null) delete source.conversion_task_id;
  return {
    ...anchor,
    kind: "image",
    quote: "",
    pdf_source: {
      ...source,
      object_id: block.id,
      book_id: reader.doc.pdf.book_id,
      source_sha256: reader.doc.pdf.source_sha256 || "",
      asset_url: block.asset_url || block.source.asset_url || "",
      revision: reader.doc.pdf.revision || "",
    },
  };
}
export function install(ctx) {
  const entries = new Set();
  const word = ctx.hook("word", ({ reader, pop, anchor, scope }) => {
    const notes = reader.notesController;
    if (!notes || !notes.validOccurrenceAnchor(anchor) || scope.signal.aborted) return;
    const entryScope = new Scope(), section = document.createElement("section");
    section.className = "word-notes-entry";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    section.append(button);
    (pop.querySelector(":scope > header") || pop.firstElementChild)?.after(section);
    const dispose = () => entryScope.dispose();
    entries.add(dispose);
    scope.cleanup(dispose);
    entryScope.cleanup(() => { section.remove(); entries.delete(dispose); });
    const render = () => {
      const action = notes.getOccurrenceNoteAction(anchor);
      if (!action) return dispose();
      button.textContent = action.label;
      button.disabled = action.disabled;
      button.setAttribute("aria-label", action.label);
    };
    entryScope.on(reader.events, "notes-change", render);
    entryScope.on(reader.events, "draw", render);
    entryScope.on(button, "click", () => {
      if (!scope.signal.aborted && !reader.scope.signal.aborted && reader.popElement === pop)
        notes.openOccurrenceNotes(anchor);
    });
    render();
  });
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
          .filter((n) =>
            (n.body + n.quote + n.title + (imageReference(n)?.label || ""))
              .toLowerCase()
              .includes(q),
          )
          .map(
            (n) =>
              `<div class="list-item"><div class="row between"><span class="meta">${e(n.title)} · ${date(n.created_at)}</span><button class="text-button" data-delete-note="${n.id}" aria-label="删除笔记">删除</button></div>${imageReference(n) ? imageExcerpt(n, n.source_available === false ? 'disabled' : `data-jump-note="${n.id}"`) : n.quote ? `<blockquote>${e(sourceExcerpt(n.quote))}</blockquote>` : ""}<p class="body">${e(n.body)}</p>${n.source_available === false ? '<span class="muted">原文已移除，笔记与引用已保留</span>' : `<button class="text-button" data-jump-note="${n.id}">回到${imageReference(n) ? "原图" : "这段原文"} →</button>`}</div>`,
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
          if (scope.signal.aborted) return;
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
    word();
    for (const dispose of [...entries]) dispose();
    read();
    route();
  };
}

export class ReaderNotes {
  constructor(reader) {
    this.r = reader;
    this.notes = [];
    this.loaded = false;
    this.filter = "book";
    this.book = reader.doc.chapter?.book_id ?? reader.doc.pdf?.book_id;
    this.ids = this.book
      ? (reader.doc.chapters || []).map((c) => c.doc_id).concat(reader.doc.id)
      : [reader.doc.id];
    this.returnKey = this.book != null
      ? `note-return:book:${this.book}`
      : `note-return:document:${reader.doc.id}`;
    this.applied = new Map();
    this.blocks = new Map(reader.doc.blocks.map((b) => [b.id, b]));
    this.noteIndex = null;
    this.deleting = new Set();
  }
  async mount() {
    const r = this.r;
    r.notesController = this;
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
      if (r.notesController === this) delete r.notesController;
    });
    await this.reload();
    if (r.scope.signal.aborted) return;
    noteStore.migrate(r.doc.id, this.notes);
    // The old global slot could point into an unrelated book. Do not migrate it.
    local.remove("note-return");
    const origin = local.get(this.returnKey);
    if (this.ownsReturn(origin)) {
      this.origin = origin;
      this.back.hidden = false;
    } else if (origin) local.remove(this.returnKey);
    this.badge();
  }
  ownsReturn(origin) {
    return !!origin?.anchor && this.ids.some(id => String(id) === String(origin.doc_id));
  }
  async reload() {
    this.notes = await api(
      this.book
        ? `/notes?book_id=${this.book}`
        : `/notes?doc_id=${this.r.doc.id}`,
      { signal: this.r.scope.signal },
    );
    if (!this.r.scope.signal.aborted) {
      this.loaded = true;
      this.noteIndex = null;
      this.paint();
      this.badge();
    }
  }
  drafts() {
    return noteStore.drafts(this.ids);
  }
  badge() {
    this.r.emit("notes-change");
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
  validOccurrenceAnchor(anchor) {
    if (!anchor || anchor.kind === "image" || anchor.version !== this.r.doc.version) return false;
    const parts = anchorSegments(anchor);
    return parts.length > 0 && parts.every(part => {
      const block = this.r.doc.blocks.find(b => b.id === part.block_id);
      return block && Number.isInteger(part.start) && Number.isInteger(part.end) &&
        part.start >= 0 && part.end > part.start && part.end <= block.text.length &&
        typeof part.quote === "string" && block.text.slice(part.start, part.end) === part.quote;
    }) && anchor.quote === parts.map(part => part.quote).join("\n\n");
  }
  occurrenceNotes(anchor) {
    if (!this.validOccurrenceAnchor(anchor)) return { notes: [], drafts: [] };
    const selected = anchorSegments(anchor);
    const matches = note => String(note.doc_id) === String(this.r.doc.id) &&
      this.validOccurrenceAnchor(note.anchor) && note.quote === note.anchor.quote &&
      anchorSegments(note.anchor).some(part => selected.some(target =>
        part.block_id === target.block_id && part.start < target.end && part.end > target.start));
    return { notes: this.notes.filter(matches), drafts: this.drafts().filter(matches) };
  }
  getOccurrenceNoteAction(anchor) {
    if (!this.validOccurrenceAnchor(anchor) || this.r.scope.signal.aborted) return null;
    const { notes, drafts } = this.occurrenceNotes(anchor);
    return { count: notes.length, draftCount: drafts.length, disabled: !this.loaded,
      label: !this.loaded ? "笔记载入中…" : notes.length ? `本处笔记 ${notes.length}` : drafts.length ? "继续笔记" : "记一笔" };
  }
  openOccurrenceNotes(value) {
    if (this.r.scope.signal.aborted || !this.loaded || !this.validOccurrenceAnchor(value)) return;
    // The notes action owns this copy before closePop disposes the word scope.
    const anchor = structuredClone(value), found = this.occurrenceNotes(anchor);
    this.r.closePop();
    if (!found.notes.length && found.drafts.length === 1) {
      this.edit(found.drafts[0], "occurrence");
      return;
    }
    if (!found.notes.length && !found.drafts.length) {
      if (!sameSelection(this.occurrenceFresh?.anchor, anchor)) this.occurrenceFresh = {
        doc_id: this.r.doc.id, book_id: this.book, anchor, quote: anchor.quote,
        client_id: crypto.randomUUID(), body: "",
      };
      this.edit(this.occurrenceFresh, "occurrence");
      return;
    }
    this.r.panel("note-occurrence", "本处笔记", '<div data-occurrence-notes></div>', (el, scope) => {
      const draw = () => {
        const { notes, drafts } = this.occurrenceNotes(anchor);
        $("[data-occurrence-notes]", el).innerHTML = notes.map(note => this.card(note)).join("") +
          drafts.map(draft => `<div class="note-draft-row"><span class="meta">未保存草稿</span><button class="text-button" data-note-resume="${e(draft.client_id)}">继续笔记</button></div>`).join("") +
          '<button class="text-button" data-note-add>＋ 再记一笔</button>';
      };
      draw();
      scope.on(this.r.events, "notes-change", draw);
      scope.on(el, "click", event => {
        this.cardAction(event, "occurrence");
        const resume = event.target.closest("[data-note-resume]");
        if (resume) {
          const draft = this.occurrenceNotes(anchor).drafts.find(d => d.client_id === resume.dataset.noteResume);
          if (draft) this.edit(draft, "occurrence");
        }
        if (event.target.closest("[data-note-add]") && this.validOccurrenceAnchor(anchor))
          this.fresh(anchor, "occurrence");
      });
    });
  }
  resolved(n) {
    if (n.doc_id !== this.r.doc.id) return null;
    if (n.anchor?.segments?.length) {
      const parts = n.anchor.segments.map(part => this.resolved({ ...n, quote: part.quote,
        anchor: { ...n.anchor, ...part, segments: [] } }));
      if (parts.some(part => !part)) return null;
      const indexes = parts.map(part => this.r.doc.blocks.findIndex(b => b.id === part.block_id));
      if (indexes.some((index, i) => i && index !== indexes[i - 1] + 1)) return null;
      return combineSelection(parts, { ...n.anchor, version: this.r.doc.version });
    }
    const image = imageReference(n);
    if (image) {
      // Asset URLs include a conversion task ID. Reprocessing the same original
      // must not detach a note from an unchanged, uniquely identified crop.
      const completeFrame = image.coordinate_space === "rotated_crop_top_left" &&
        Number.isInteger(image.page_number) && image.page_number > 0 &&
        Number.isFinite(image.width) && image.width > 0 &&
        Number.isFinite(image.height) && image.height > 0 &&
        [0, 90, 180, 270].includes(image.rotation) &&
        Array.isArray(image.crop_box) && image.crop_box.length === 4 &&
        image.crop_box.every(Number.isFinite);
      if (image.source_sha256 && completeFrame) {
        if (image.source_sha256 !== this.r.doc.pdf?.source_sha256 ||
            (image.book_id != null && String(image.book_id) !== String(this.r.doc.pdf?.book_id)) ||
            !Array.isArray(image.bbox) || image.bbox.length !== 4 ||
            !image.bbox.every(Number.isFinite)) return null;
        const matches = this.r.doc.blocks.filter(block => block.asset_url &&
          block.source?.page_number === image.page_number &&
          Array.isArray(block.source.bbox) && block.source.bbox.length === 4 &&
          image.bbox.every((value, i) => value === block.source.bbox[i]) &&
          ["coordinate_space", "width", "height", "rotation"].every(key =>
            image[key] === block.source[key]) &&
          JSON.stringify(image.crop_box) === JSON.stringify(block.source.crop_box));
        if (matches.length !== 1) return null;
        const block = matches[0];
        return { ...n.anchor, block_id: block.id, version: this.r.doc.version,
          start: 0, end: block.text?.length || 1 };
      }
      const block = this.r.doc.blocks.find((b) => b.id === n.anchor.block_id);
      if (!block?.source) return null;
      if (
        image.source_sha256 &&
        image.source_sha256 !== this.r.doc.pdf?.source_sha256
      )
        return null;
      if (image.asset_url) {
        const currentURL = imageReference({
          anchor: {
            kind: "image",
            pdf_source: {
              ...block.source,
              book_id: this.r.doc.pdf?.book_id,
              asset_url: block.asset_url,
            },
          },
        })?.asset_url;
        if (currentURL !== image.asset_url) return null;
      } else if (n.anchor.version !== this.r.doc.version) return null;
      if (
        block.source.page_number !== image.page_number ||
        JSON.stringify(block.source.bbox) !== JSON.stringify(image.bbox)
      )
        return null;
      return { ...n.anchor, start: 0, end: block.text?.length || 1 };
    }
    if (!n.quote) return null;
    if (this.r.doc.pdf) {
      const source = n.anchor?.pdf_source;
      if (
        !source ||
        (source.source_sha256 &&
          source.source_sha256 !== this.r.doc.pdf.source_sha256)
      )
        return null;
      const matches = this.r.doc.blocks.filter(
        (block) =>
          block.source?.page_number === source.page_number &&
          Array.isArray(source.bbox) &&
          source.bbox.length === 4 &&
          Array.isArray(block.source.bbox) &&
          source.bbox.every(
            (number, i) =>
              Number.isFinite(number) &&
              Math.abs(number - block.source.bbox[i]) <= 0.1,
          ),
      );
      if (matches.length !== 1) return null;
      const block = this.r.pdfAnchorBlock?.(n.anchor) || matches[0];
      if (block.id !== matches[0].id) return null;
      const start = n.anchor?.start || 0,
        end = n.anchor?.end || start + n.quote.length;
      if (block.text.slice(start, end) !== n.quote) return null;
      return { ...n.anchor, block_id: block.id, start, end, quote: n.quote };
    }
    let block = this.r.doc.blocks.find((b) => b.id === n.anchor?.block_id);
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
    $$("#article .pdf-object.has-note").forEach((el) =>
      el.classList.remove("has-note"),
    );
    if (this.indexVersion !== this.r.doc.version) {
      this.indexVersion = this.r.doc.version;
      this.noteIndex = null;
      this.blocks = new Map(this.r.doc.blocks.map((b) => [b.id, b]));
    }
    if (!this.noteIndex) {
      this.noteIndex = new Map();
      for (const note of this.notes) {
        const anchor = this.resolved(note);
        if (!anchor) continue;
        for (const part of anchorSegments(anchor)) {
          if (!this.noteIndex.has(part.block_id)) this.noteIndex.set(part.block_id, []);
          this.noteIndex.get(part.block_id).push(part);
        }
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
      (el.closest(".source-row") || el).append(marker);
      if (anchors.some((a) => a.kind === "image")) {
        el.classList.add("has-note");
        return;
      }
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
    if (imageReference(n)) return imageReference(n).label;
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
    return `<article class="reader-note-item" data-note-id="${n.id}">${imageReference(n) ? imageExcerpt(n, `data-note-jump="${n.id}" title="回到原图"`) : n.quote ? `<button class="note-excerpt" data-note-jump="${n.id}" title="回到这段原文">${e(sourceExcerpt(n.quote))}</button>` : ""}<p class="note-thought">${e(n.body)}</p><div class="note-item-actions"><span class="meta">${e(this.location(n))}${this.r.doc.pdf && n.doc_id === this.r.doc.id && n.anchor && !this.resolved(n) ? " · 旧引用保留" : ""}</span><button class="text-button" data-note-edit="${n.id}">编辑</button><button class="icon-button" data-note-more="${n.id}" aria-label="笔记更多操作" aria-expanded="false">⋯</button></div><div data-note-delete-zone="${n.id}" hidden><button class="text-button note-danger" data-note-delete="${n.id}">删除笔记</button></div></article>`;
  }
  currentChapter(n) {
    if ((!n.quote && !imageReference(n)) || n.doc_id !== this.r.doc.id)
      return false;
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
    if (this.r.scope.signal.aborted) return;
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
      (n) => anchorSegments(this.resolved(n)).some(part => part.block_id === block_id),
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
            if (!b) return;
            if (
              imageReference({
                anchor: {
                  kind:
                    b.source &&
                    ["image", "image_fallback", "formula", "table"].includes(
                      b.type,
                    )
                      ? "image"
                      : "text",
                  pdf_source: b.source,
                },
              })
            ) {
              this.addImage(b);
              return;
            }
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
  addImage(block) {
    const anchor = imageAnchor(this.r, block);
    if (!anchor) {
      toast("这张图的来源暂不可用，原图引用未创建。");
      return;
    }
    this.fresh(anchor);
  }
  edit(note, origin) {
    if (origin === "source" && note.anchor && note.anchor.kind !== "image")
      this.r.choose(this.resolved(note) || note.anchor);
    const rect = origin === "source" ? this.sourceRect(note.anchor) : null,
      entry = noteStore.entry(note);
    if (this.drafts().some((d) => d.client_id === entry.client_id)) {
      if (entry.state === "idle") entry.state = "draft";
      entry.durable = true;
    }
    if (origin === "source") this.r.focus.close();
    if (this.r.panelId === "notes") this.r.closePanel();
    this.r.panel(
      "notes",
      note.id
        ? "编辑笔记"
        : note.quote || imageReference(note)
          ? "记一笔"
          : "写随记",
      `${origin === "list" ? '<button class="text-button" id="note-back">← 返回笔记列表</button>' : ""}<span class="meta">${e(this.location(note))}</span>${imageReference(entry) ? imageExcerpt(entry, 'id="note-quote" aria-expanded="false" title="展开原图引用"') : entry.quote ? `<button class="note-excerpt note-editor-quote" id="note-quote" aria-expanded="false" title="展开引用">${e(sourceExcerpt(entry.quote))}</button>` : ""}<label for="note-body">我的想法</label><textarea id="note-body" rows="3" placeholder="写下此刻的想法…">${e(entry.body)}</textarea><div class="note-editor-footer"><span id="note-state" class="save-state" role="status"></span><button id="note-retry" class="text-button" hidden>重试</button><button id="note-done">完成</button></div>`,
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
      if (this.r.scope.signal.aborted) return;
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
    if (!this.ids.some(id => String(id) === String(note.doc_id))) return;
    if (
      note.doc_id === this.r.doc.id &&
      this.r.doc.pdf &&
      note.anchor?.pdf_source &&
      !this.resolved(note)
    ) {
      if (this.r.pdfTools?.openOriginal)
        this.r.pdfTools.openOriginal(note.anchor.pdf_source);
      else toast("旧引用已保留，当前结果无法可靠对应；请核对原版。");
      return;
    }
    const anchor = this.resolved(note) || note.anchor || { quote: note.quote };
    this.origin ||= { doc_id: this.r.doc.id, anchor: this.r.position() };
    this.r.returnAnchor =
      this.origin.doc_id === this.r.doc.id ? this.origin.anchor : null;
    local.set(this.returnKey, this.origin);
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
    this.origin = null;
    local.remove(this.returnKey);
    this.back.hidden = true;
    this.r.returnAnchor = null;
    if (!this.ownsReturn(origin)) return;
    if (origin.doc_id !== this.r.doc.id)
      this.r.ctx.jump(origin.doc_id, origin.anchor);
    else await this.r.restore(origin.anchor);
  }
}
