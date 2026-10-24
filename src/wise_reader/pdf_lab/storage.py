"""Small durable registry for the isolated PDF lab, separate from the user library."""

from contextlib import contextmanager
import hashlib
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path

ACTIVE_STATES = {"queued", "running"}


class LabStore:
    def __init__(self, root: Path):
        self.root = root.resolve()
        for name in ("originals", "incoming", "tasks"):
            (self.root / name).mkdir(parents=True, exist_ok=True, mode=0o700)
        self.database = self.root / "registry.sqlite3"
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS books (
                    id TEXT PRIMARY KEY, title TEXT NOT NULL,
                    file_sha256 TEXT NOT NULL UNIQUE, byte_size INTEGER NOT NULL,
                    page_count INTEGER NOT NULL, created_at REAL NOT NULL,
                    latest_task_id TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY, book_id TEXT NOT NULL REFERENCES books(id),
                    state TEXT NOT NULL, engine TEXT NOT NULL,
                    start_page INTEGER NOT NULL, end_page INTEGER NOT NULL,
                    done_pages INTEGER NOT NULL DEFAULT 0,
                    error TEXT, metrics TEXT NOT NULL DEFAULT '{}',
                    created_at REAL NOT NULL, updated_at REAL NOT NULL, pid INTEGER
                );
                CREATE INDEX IF NOT EXISTS tasks_book_created ON tasks(book_id, created_at);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=5)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys = ON")
            with db:
                yield db
        finally:
            db.close()

    def source(self, book: dict) -> Path:
        return self.root / "originals" / (book["file_sha256"] + ".pdf")

    def output(self, task: dict) -> Path:
        return self.root / "tasks" / task["id"]

    @staticmethod
    def decode_task(row):
        if row is None:
            return None
        task = dict(row)
        task["metrics"] = json.loads(task["metrics"])
        task["error"] = json.loads(task["error"]) if task["error"] else None
        task["total_pages"] = task["end_page"] - task["start_page"] + 1
        return task

    def book(self, book_id: str):
        with self.connect() as db:
            row = db.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        return dict(row) if row else None

    def books(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute("SELECT * FROM books ORDER BY created_at DESC")]

    def task(self, task_id: str):
        with self.connect() as db:
            return self.decode_task(db.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone())

    def tasks(self, book_id: str | None = None):
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM tasks WHERE book_id = ? ORDER BY created_at" if book_id else
                "SELECT * FROM tasks ORDER BY created_at", (book_id,) if book_id else (),
            )
            return [self.decode_task(r) for r in rows]

    def register(self, temporary: Path, title: str, digest: str, size: int,
                 page_count: int, elapsed_ms: float):
        now = time.time()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT id FROM books WHERE file_sha256 = ?", (digest,)).fetchone()
            if old:
                temporary.unlink(missing_ok=True)
                book_id, reused = old["id"], True
            else:
                book_id, task_id = uuid.uuid4().hex, uuid.uuid4().hex
                destination = self.root / "originals" / (digest + ".pdf")
                os.replace(temporary, destination)
                os.chmod(destination, 0o600)
                directory_fd = os.open(destination.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
                db.execute("INSERT INTO books VALUES (?, ?, ?, ?, ?, ?, ?)",
                           (book_id, title, digest, size, page_count, now, task_id))
                db.execute("""INSERT INTO tasks
                    (id, book_id, state, engine, start_page, end_page, metrics, created_at, updated_at)
                    VALUES (?, ?, 'preparing', 'auto', 1, ?, ?, ?, ?)""",
                           (task_id, book_id, page_count, json.dumps({
                               "import_registered_ms": round(elapsed_ms, 3),
                               "registered_at": now, "ready_pages": 0,
                           }), now, now))
                reused = False
        book = self.book(book_id)
        return book, self.task(book["latest_task_id"]), reused

    def new_task(self, book: dict, engine: str, start: int, end: int):
        now, task_id = time.time(), uuid.uuid4().hex
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("""INSERT INTO tasks
                (id, book_id, state, engine, start_page, end_page, created_at, updated_at)
                VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)""",
                       (task_id, book["id"], engine, start, end, now, now))
            db.execute("UPDATE books SET latest_task_id = ? WHERE id = ?", (task_id, book["id"]))
        return self.task(task_id)

    def select_task(self, book_id: str, task_id: str):
        with self.connect() as db:
            db.execute("UPDATE books SET latest_task_id = ? WHERE id = ?", (task_id, book_id))

    def update(self, task_id: str, **fields):
        allowed = {"state", "engine", "done_pages", "error", "metrics", "pid"}
        if not fields.keys() <= allowed:
            raise ValueError("Unknown task fields")
        fields["updated_at"] = time.time()
        for name in ("error", "metrics"):
            if name in fields and fields[name] is not None:
                fields[name] = json.dumps(fields[name], ensure_ascii=False)
        with self.connect() as db:
            db.execute("UPDATE tasks SET " + ", ".join(f"{k} = ?" for k in fields) + " WHERE id = ?",
                       (*fields.values(), task_id))
        return self.task(task_id)

    def recover_registry(self):
        """Reconcile registered originals without trusting names or erasing task history."""
        missing, invalid, restored = [], [], []
        for book in self.books():
            source = self.source(book)
            verified = False
            try:
                if not source.is_symlink() and source.is_file() and source.stat().st_size == book["byte_size"]:
                    digest = hashlib.sha256()
                    with source.open("rb") as stream:
                        while chunk := stream.read(1024 * 1024):
                            digest.update(chunk)
                    verified = digest.hexdigest() == book["file_sha256"]
            except OSError:
                pass
            task = self.task(book["latest_task_id"])
            if not verified:
                missing.append(book["id"])
                if source.exists() or source.is_symlink():
                    invalid.append(book["id"])
                if not task["error"] or task["error"].get("code") != "source_missing":
                    self.update(task["id"], state="failed", error={
                        "code": "source_missing",
                        "message": "Registered original is missing or failed validation.",
                        "previous_state": task["state"],
                        "previous_error": task["error"],
                    })
                continue
            if task["error"] and task["error"].get("code") == "source_missing":
                previous = task["error"].get("previous_state")
                previous_error = task["error"].get("previous_error")
                if previous not in {"completed", "partial", "paused", "cancelled", "failed"}:
                    total = task["end_page"] - task["start_page"] + 1
                    metrics = task["metrics"].get("conversion_metrics", {})
                    previous = "completed" if (
                        task["done_pages"] >= total and
                        (metrics.get("range_complete") or metrics.get("full_document_complete"))
                    ) else ("partial" if task["done_pages"] else None)
                    previous_error = None
                if previous:
                    self.update(task["id"], state=previous, error=previous_error)
                    restored.append(book["id"])
        known = {b["file_sha256"] + ".pdf" for b in self.books()}
        report = {
            "missing_books": missing,
            "invalid_originals": invalid,
            "restored_books": restored,
            "unregistered_originals": [p.name for p in (self.root / "originals").glob("*.pdf")
                                      if p.name not in known],
            "interrupted_uploads": [p.name for p in (self.root / "incoming").iterdir()],
        }
        (self.root / "recovery.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
