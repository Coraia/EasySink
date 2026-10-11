"""用户库：profile / 词表 / 文章 / L1 缓存 / 阅读日志。与词库严格分离。"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from threading import RLock

from wise_reader.models import Annotation
from wise_reader.profile import ReaderProfile

DATA = Path(__file__).resolve().parent.parent.parent / "data"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: Path | None = None):
        self._lock = RLock()
        self._depth = 0
        self.path = path or DATA / "user.db"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._con = sqlite3.connect(str(self.path), check_same_thread=False)
        self._con.row_factory = sqlite3.Row
        self._con.execute("PRAGMA journal_mode=WAL")
        self._init()
        from wise_reader.content import migrate

        migrate(self)

    def _init(self) -> None:
        self._con.executescript(
            """
            CREATE TABLE IF NOT EXISTS profile (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                vocab_size INTEGER NOT NULL DEFAULT 8000,
                density REAL NOT NULL DEFAULT 4.0,
                domains TEXT NOT NULL DEFAULT '[]',
                repeat_annotations INTEGER NOT NULL DEFAULT 0,
                l1_enabled INTEGER NOT NULL DEFAULT 1
            );
            INSERT OR IGNORE INTO profile (id) VALUES (1);

            CREATE TABLE IF NOT EXISTS word_verdict (
                lemma TEXT PRIMARY KEY,
                verdict TEXT NOT NULL CHECK (verdict IN ('known','unknown')),
                updated_at TEXT NOT NULL,
                source TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS document (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                text TEXT NOT NULL,
                word_count INTEGER NOT NULL,
                text_hash TEXT NOT NULL,
                l0_json TEXT NOT NULL,
                l1_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS annotation_cache (
                text_hash TEXT NOT NULL,
                layer TEXT NOT NULL,
                payload TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                PRIMARY KEY (text_hash, layer)
            );

            CREATE TABLE IF NOT EXISTS reading_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                doc_id INTEGER NOT NULL,
                finished_at TEXT NOT NULL,
                annotation_count INTEGER NOT NULL,
                manual_lookups INTEGER NOT NULL DEFAULT 0,
                felt_density TEXT
            );

            CREATE TABLE IF NOT EXISTS plugin_flag (
                id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL
            );
            """
        )
        columns = {row["name"] for row in self._con.execute("PRAGMA table_info(profile)")}
        if "focus_domains" not in columns:
            # Familiarity is not a request for help. Never backfill from domains.
            self._con.execute("ALTER TABLE profile ADD COLUMN focus_domains TEXT NOT NULL DEFAULT '[]'")
        self._commit()

    def get_profile(self) -> ReaderProfile:
        row = self._con.execute("SELECT * FROM profile WHERE id = 1").fetchone()
        known = set()
        unknown = set()
        for r in self._con.execute("SELECT lemma, verdict FROM word_verdict"):
            if r["verdict"] == "known":
                known.add(r["lemma"])
            else:
                unknown.add(r["lemma"])
        return ReaderProfile(
            vocab_size=row["vocab_size"],
            known=known,
            unknown=unknown,
            domains=set(json.loads(row["domains"])),
            focus_domains=set(json.loads(row["focus_domains"])),
            density=row["density"],
            repeat=bool(row["repeat_annotations"]),
            l1_enabled=bool(row["l1_enabled"]),
        )

    def update_profile(self, **fields) -> ReaderProfile:
        allowed = {
            "vocab_size",
            "density",
            "domains",
            "focus_domains",
            "repeat_annotations",
            "l1_enabled",
        }
        sets = []
        vals = []
        for k, v in fields.items():
            if k == "repeat":
                k = "repeat_annotations"
            if k not in allowed:
                continue
            if k in ("domains", "focus_domains"):
                v = json.dumps(sorted(v) if not isinstance(v, str) else json.loads(v))
            if k in ("repeat_annotations", "l1_enabled"):
                v = 1 if v else 0
            sets.append(f"{k} = ?")
            vals.append(v)
        if sets:
            self._con.execute(
                f"UPDATE profile SET {', '.join(sets)} WHERE id = 1", vals
            )
            self._commit()
        return self.get_profile()

    def set_verdict(self, lemma: str, verdict: str, source: str = "feedback") -> None:
        lemma = lemma.lower().strip()
        if not lemma:
            raise ValueError("empty lemma")
        if verdict not in ("known", "unknown"):
            raise ValueError(verdict)
        self._con.execute(
            "INSERT INTO word_verdict(lemma, verdict, updated_at, source)"
            " VALUES (?,?,?,?)"
            " ON CONFLICT(lemma) DO UPDATE SET verdict=excluded.verdict,"
            " updated_at=excluded.updated_at, source=excluded.source",
            (lemma, verdict, _now(), source),
        )
        self._commit()

    def save_document(
        self,
        title: str,
        text: str,
        word_count: int,
        text_hash: str,
        l0: list[Annotation],
        l1: list[Annotation],
    ) -> int:
        cur = self._con.execute(
            "INSERT INTO document(title, text, word_count, text_hash, l0_json, l1_json, created_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (
                title,
                text,
                word_count,
                text_hash,
                json.dumps([a.to_dict() for a in l0], ensure_ascii=False),
                json.dumps([a.to_dict() for a in l1], ensure_ascii=False),
                _now(),
            ),
        )
        self._commit()
        return int(cur.lastrowid)

    def get_document(self, doc_id: int) -> dict | None:
        row = self._con.execute(
            "SELECT * FROM document WHERE id = ?", (doc_id,)
        ).fetchone()
        if row is None:
            return None
        return dict(row)

    def list_documents(self) -> list[dict]:
        rows = self._con.execute(
            "SELECT id, title, word_count, created_at FROM document ORDER BY id DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def delete_document(self, doc_id: int) -> None:
        from wise_reader.note_sources import preserve
        with self.transaction():
            preserve(self, doc_id)
            self._delete_document_source(doc_id)

    def _delete_document_source(self, doc_id: int) -> None:
        self._con.execute("DELETE FROM document WHERE id = ?", (doc_id,))
        for table in (
            "reading_log",
            "wr_bookmark",
            "wr_progress",
            "wr_translation",
            "wr_assist",
            "wr_review",
            "wr_session_time",
            "wr_chapter",
            "wr_source_analysis",
        ):
            exists = self._con.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                (table,),
            ).fetchone()
            if exists:
                self._con.execute(f"DELETE FROM {table} WHERE doc_id = ?", (doc_id,))
        self._commit()

    def get_l1_cache(self, text_hash: str) -> list[Annotation] | None:
        row = self._con.execute(
            "SELECT payload FROM annotation_cache WHERE text_hash = ? AND layer = 'L1'",
            (text_hash,),
        ).fetchone()
        if row is None:
            return None
        return [Annotation.from_dict(d) for d in json.loads(row["payload"])]

    def put_l1_cache(
        self, text_hash: str, annos: list[Annotation], model: str = ""
    ) -> None:
        self._con.execute(
            "INSERT OR REPLACE INTO annotation_cache(text_hash, layer, payload, model, created_at)"
            " VALUES (?,?,?,?,?)",
            (
                text_hash,
                "L1",
                json.dumps([a.to_dict() for a in annos], ensure_ascii=False),
                model,
                _now(),
            ),
        )
        self._commit()

    def add_reading_log(
        self,
        doc_id: int,
        annotation_count: int,
        manual_lookups: int,
        felt_density: str | None,
    ) -> None:
        self._con.execute(
            "INSERT INTO reading_log(doc_id, finished_at, annotation_count, manual_lookups, felt_density)"
            " VALUES (?,?,?,?,?)",
            (doc_id, _now(), annotation_count, manual_lookups, felt_density),
        )
        self._commit()

    def list_reading_logs(self) -> list[dict]:
        rows = self._con.execute(
            "SELECT r.*, d.title FROM reading_log r"
            " LEFT JOIN document d ON d.id = r.doc_id"
            " ORDER BY r.id DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def known_count(self) -> int:
        n = self._con.execute("SELECT COUNT(*) FROM word_verdict").fetchone()[0]
        return int(n)

    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        cur = self._con.execute(sql, params)
        self._commit()
        return cur

    def executescript(self, sql: str) -> None:
        self._con.executescript(sql)
        self._commit()

    def query(self, sql: str, params: tuple = ()) -> list[dict]:
        return [dict(r) for r in self._con.execute(sql, params).fetchall()]

    def query_one(self, sql: str, params: tuple = ()) -> dict | None:
        row = self._con.execute(sql, params).fetchone()
        return dict(row) if row else None

    def is_plugin_enabled(self, plugin_id: str, default: bool = True) -> bool:
        row = self.query_one(
            "SELECT enabled FROM plugin_flag WHERE id = ?", (plugin_id,)
        )
        if row is None:
            return default
        return bool(row["enabled"])

    def set_plugin_enabled(self, plugin_id: str, enabled: bool) -> None:
        self.execute(
            "INSERT INTO plugin_flag(id, enabled) VALUES (?,?)"
            " ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled",
            (plugin_id, 1 if enabled else 0),
        )

    def plugin_flags(self) -> dict[str, bool]:
        return {
            r["id"]: bool(r["enabled"])
            for r in self.query("SELECT id, enabled FROM plugin_flag")
        }

    def _commit(self):
        if not self._depth:
            self._con.commit()

    @contextmanager
    def transaction(self):
        with self._lock:
            self._depth += 1
            try:
                yield
                if self._depth == 1:
                    self._con.commit()
            except BaseException:
                if self._depth == 1:
                    self._con.rollback()
                raise
            finally:
                self._depth -= 1

    def close(self) -> None:
        self._con.close()


# A single serialized connection, including complete read/modify/write transactions.
def _serialized(fn):
    @wraps(fn)
    def call(self, *args, **kwargs):
        with self._lock:
            return fn(self, *args, **kwargs)

    return call


for _name in tuple(vars(Store)):
    if not _name.startswith("_") and _name != "transaction":
        setattr(Store, _name, _serialized(getattr(Store, _name)))
