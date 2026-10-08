import { api, local } from "../core.js";

// Notes own their queues and drafts. Closing a reader never aborts an issued save.
const KEY = "note-drafts-v3";
const entries = new Map();
const listeners = new Set();
const notify = (entry) => listeners.forEach((fn) => fn(entry));
const disk = () => local.get(KEY, []);
const persist = (entry, remove = false) => {
  const drafts = disk().filter((d) => d.client_id !== entry.client_id);
  if (!remove) {
    const { id, client_id, doc_id, book_id, quote, anchor, body } = entry;
    drafts.push({ id, client_id, doc_id, book_id, quote, anchor, body });
  }
  return local.set(KEY, drafts);
};
export const noteStore = {
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  drafts(ids) {
    return disk().filter((d) => ids.includes(d.doc_id));
  },
  migrate(doc_id, notes) {
    const key = `note-draft:${doc_id}`,
      old = local.get(key);
    if (!old) return;
    const saved = notes.find((n) => n.id === old.id);
    if (old.body?.trim() && (!saved || old.body.trim() !== saved.body)) {
      const draft = {
        ...old,
        doc_id,
        client_id: old.client_id || crypto.randomUUID(),
      };
      if (!persist(draft)) return;
    }
    local.remove(key);
  },
  entry(value) {
    const key =
      value.client_id || (value.id ? `note-${value.id}` : crypto.randomUUID());
    if (!entries.has(key))
      entries.set(key, {
        ...value,
        client_id: key,
        body: value.body || "",
        revision: 0,
        savedBody: value.id && !value.client_id ? value.body : null,
        chain: Promise.resolve(),
        deleted: false,
        state: "idle",
        error: "",
      });
    return entries.get(key);
  },
  change(entry, body) {
    entry.body = body;
    entry.revision++;
    entry.durable = persist(entry, !body.trim());
    entry.state = body.trim() ? "saving" : "empty";
    clearTimeout(entry.timer);
    if (body.trim()) entry.timer = setTimeout(() => this.save(entry), 550);
    notify(entry);
  },
  save(entry) {
    clearTimeout(entry.timer);
    if (entry.deleted || !entry.body.trim()) return entry.chain;
    const body = entry.body,
      revision = entry.revision;
    // Capture each edit independently, but resolve the assigned server id in queue order.
    entry.chain = entry.chain
      .catch(() => {})
      .then(async () => {
        if (entry.deleted) return;
        if (entry.savedBody === body.trim()) {
          if (entry.revision === revision) {
            entry.state = "saved";
            persist(entry, true);
            notify(entry);
          }
          return;
        }
        try {
          const saved = await api(entry.id ? `/notes/${entry.id}` : "/notes", {
            method: entry.id ? "PUT" : "POST",
            keepalive: true,
            body: {
              doc_id: entry.doc_id,
              client_id: entry.client_id,
              quote: entry.quote || "",
              anchor: entry.anchor,
              body,
            },
          });
          entry.id = saved.id;
          entry.error = "";
          entry.saved = saved;
          entry.savedBody = saved.body;
          if (entry.revision === revision) {
            entry.state = "saved";
            persist(entry, true);
          } else entry.durable = persist(entry, !entry.body.trim());
        } catch (err) {
          if (entry.revision === revision) {
            entry.state = "failed";
            entry.error = err.message;
            entry.durable = persist(entry);
          }
        }
        notify(entry);
      });
    return entry.chain;
  },
  finish(entry) {
    if (!entry.body.trim() && entry.id && entry.savedBody) {
      entry.body = entry.savedBody;
      entry.state = "saved";
      persist(entry, true);
    }
    return this.save(entry);
  },
  async discard(draft) {
    const entry = entries.get(draft.client_id);
    if (entry) {
      entry.deleted = true;
      clearTimeout(entry.timer);
      await entry.chain;
      entries.delete(entry.client_id);
    }
    persist(draft, true);
    notify();
  },
  async remove(note) {
    const related = [...entries.values()].filter(
      (entry) => entry.id === note.id,
    );
    for (const entry of related) {
      clearTimeout(entry.timer);
      entry.deleted = true;
    }
    await Promise.all(related.map((entry) => entry.chain));
    try {
      await api(`/notes/${note.id}`, { method: "DELETE" });
    } catch (err) {
      related.forEach((entry) => {
        entry.deleted = false;
      });
      throw err;
    }
    const latest =
      related
        .map((entry) => entry.saved)
        .filter(Boolean)
        .at(-1) || note;
    for (const draft of disk().filter((d) => d.id === note.id))
      persist(draft, true);
    for (const entry of related) entries.delete(entry.client_id);
    notify();
    return latest;
  },
  async undo(note) {
    const saved = await api("/notes", {
      method: "POST",
      body: { ...note, client_id: crypto.randomUUID() },
    });
    notify();
    return saved;
  },
};
