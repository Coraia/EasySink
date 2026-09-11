import { $, $$, e, api, local, date, toast } from "../core.js";
const pendingSaves = new Map();
export function install(ctx) {
  const read = ctx.hook("read", (reader) =>
    reader.tool("notes", "笔记", () => notesPanel(reader)),
  );
  const selection = ctx.hook("selection", (reader) => {
    const b = $("#tool-notes");
    if (b) b.textContent = "笔记 · 已选文字";
  });
  async function notesPanel(reader) {
    const doc_id = reader.doc.id,
      key = `note-draft:${doc_id}`;
    const draft = local.get(key, {
      body: "",
      quote: "",
      anchor: null,
      id: null,
    });
    draft.client_id ||= crypto.randomUUID();
    if (!draft.body && reader.selection) {
      draft.quote = reader.selection.quote;
      draft.anchor = reader.selection;
    }
    await reader.panel(
      "notes",
      "阅读笔记",
      `<p class="muted">选中同一段内的文字，可带着原句记笔记。</p><div class="quote-preview" id="note-quote">${e(draft.quote || "未选择原句")}</div><button class="text-button" id="use-selection">使用当前选中的文字</button><label class="gap" for="note-body">我的想法</label><textarea id="note-body" rows="6" placeholder="这段文字让你想到了什么？">${e(draft.body)}</textarea><div class="row between gap"><span class="save-state" id="note-state" role="status">${draft.id ? "已保存，可继续编辑" : "输入后自动保存"}</span><button id="new-note">新笔记</button></div><div class="section-heading"><h3>本篇笔记</h3></div><div id="doc-notes"></div>`,
      async (el, scope) => {
        let value = { ...draft },
          timer = null,
          chain = Promise.resolve(),
          revision = 0,
          savedRevision = -1;
        const renderList = async () => {
          try {
            const notes = await api("/notes?doc_id=" + doc_id, {
              signal: scope.signal,
            });
            if (scope.signal.aborted) return;
            $("#doc-notes", el).innerHTML =
              notes
                .map(
                  (n) =>
                    `<div class="list-item"><p class="body">${e(n.body)}</p><div class="row between"><button class="text-button" data-note-jump="${n.id}">回到原文 ↗</button><button class="text-button" data-note-edit="${n.id}">编辑</button></div></div>`,
                )
                .join("") ||
              '<p class="muted">你的第一条想法，会出现在这里。</p>';
            $$("[data-note-jump]", el).forEach((b) =>
              scope.on(b, "click", () =>
                reader.restore(
                  notes.find((n) => n.id === +b.dataset.noteJump).anchor || {
                    quote: notes.find((n) => n.id === +b.dataset.noteJump)
                      .quote,
                  },
                ),
              ),
            );
            $$("[data-note-edit]", el).forEach((b) =>
              scope.on(b, "click", async () => {
                await save();
                if (savedRevision < 0 && value.body.trim()) return;
                const n = notes.find((n) => n.id === +b.dataset.noteEdit);
                value = {
                  id: n.id,
                  client_id: "note-" + n.id,
                  body: n.body,
                  quote: n.quote,
                  anchor: n.anchor,
                };
                $("#note-body", el).value = n.body;
                $("#note-quote", el).textContent = n.quote || "未选择原句";
                local.set(key, value);
                $("#note-state", el).textContent = "已载入，可继续编辑";
              }),
            );
          } catch (err) {
            if (!scope.signal.aborted)
              $("#doc-notes", el).textContent = err.message;
          }
        };
        const save = () => {
          clearTimeout(timer);
          if (!value.body.trim() || savedRevision === revision) return chain;
          const rev = revision,
            snapshot = { ...value };
          savedRevision = rev;
          chain = (pendingSaves.get(key) || chain)
            .catch(() => {})
            .then(async () => {
              const n = await api(
                snapshot.id ? "/notes/" + snapshot.id : "/notes",
                {
                  method: snapshot.id ? "PUT" : "POST",
                  body: {
                    doc_id,
                    client_id: snapshot.client_id,
                    body: snapshot.body,
                    quote: snapshot.quote,
                    anchor: snapshot.anchor,
                  },
                  keepalive: true,
                },
              );
              if (value.client_id === snapshot.client_id) value.id = n.id;
              const current = local.get(key);
              if (current?.client_id === snapshot.client_id)
                local.set(key, { ...current, id: n.id });
              if (!scope.signal.aborted && rev === revision) {
                $("#note-state", el).textContent = "已自动保存 ✓";
                await renderList();
              }
            })
            .catch((err) => {
              savedRevision = -1;
              if (!scope.signal.aborted) {
                $("#note-state", el).textContent = "未同步 · 草稿已保留";
                toast(err.message);
              }
            });
          pendingSaves.set(key, chain);
          return chain;
        };
        const changed = () => {
          revision++;
          value.body = $("#note-body", el).value;
          local.set(key, value);
          $("#note-state", el).textContent = value.body.trim()
            ? "保存中…"
            : "空白草稿 · 不会覆盖已存笔记";
          clearTimeout(timer);
          timer = setTimeout(save, 700);
        };
        scope.on($("#note-body", el), "input", changed);
        scope.on($("#use-selection", el), "click", () => {
          if (!reader.selection) {
            toast("先在正文选中一段文字");
            return;
          }
          value.quote = reader.selection.quote;
          value.anchor = reader.selection;
          $("#note-quote", el).textContent = value.quote;
          changed();
        });
        scope.on($("#new-note", el), "click", async () => {
          await save();
          if (savedRevision < 0 && value.body.trim()) return;
          value = {
            id: null,
            client_id: crypto.randomUUID(),
            body: "",
            quote: "",
            anchor: null,
          };
          revision++;
          savedRevision = -1;
          local.remove(key);
          $("#note-body", el).value = "";
          $("#note-quote", el).textContent = "未选择原句";
          $("#note-state", el).textContent = "输入后自动保存";
          $("#note-body", el).focus();
        });
        scope.cleanup(() => {
          clearTimeout(timer);
          save();
        });
        scope.on(window, "pagehide", save);
        scope.on(window, "online", () => {
          savedRevision = -1;
          save();
        });
        await renderList();
      },
    );
  }
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
          await api("/notes/" + n.id, { method: "DELETE" });
          notes.splice(notes.indexOf(n), 1);
          if (local.get(`note-draft:${n.doc_id}`)?.id === n.id)
            local.remove(`note-draft:${n.doc_id}`);
          draw();
          toast("笔记已删除", {
            label: "撤销",
            run: async () => {
              await api("/notes", { method: "POST", body: n });
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
    selection();
    route();
  };
}
