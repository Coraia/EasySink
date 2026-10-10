"""Keep independent notes and their provenance when the original is removed."""
import json


def migrate(store):
    if "source_snapshot" not in {r["name"] for r in store.query("PRAGMA table_info(wr_note)")}:
        store.execute("ALTER TABLE wr_note ADD COLUMN source_snapshot TEXT NOT NULL DEFAULT ''")
    store.execute("""CREATE TABLE IF NOT EXISTS wr_note_undo (
        token TEXT PRIMARY KEY, doc_id INTEGER NOT NULL, book_id INTEGER,
        payload TEXT NOT NULL, created_at TEXT NOT NULL)""")


def source_snapshot(store, note):
    """Capture provenance before deletion, preserving any earlier snapshot verbatim.

    Call while holding the transaction that removes the note or its source.
    Live notes supply anchor_json; deletion receipts supply the saved anchor.
    """
    if note.get("source_snapshot"):
        return note["source_snapshot"]
    from wise_reader.collections import Collections
    from wise_reader.collections_transfer import note_snapshot

    row = dict(note)
    if "anchor_json" not in row:
        row["anchor_json"] = json.dumps(row["anchor"], ensure_ascii=False) if row.get("anchor") else None
    return json.dumps(note_snapshot(Collections(store), row), ensure_ascii=False)


def preserve(store, doc_id):
    if not store.get_document(doc_id) or not store.query_one(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='wr_note'"):
        return
    migrate(store)
    rows = store.query("""SELECT n.*, a.payload AS anchor_json FROM wr_note n
        LEFT JOIN wr_anchor a ON a.owner='note' AND a.owner_id=n.id WHERE n.doc_id=?""", (doc_id,))
    for row in rows:
        if not row["source_snapshot"]:
            store.execute("UPDATE wr_note SET source_snapshot=? WHERE id=?",
                          (source_snapshot(store, row), row["id"]))
