"""Durable PDF original/task bridge to the existing book and document model."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import time
from pathlib import Path

from wise_reader import content
from wise_reader.pdf_lab.storage import LabStore
from wise_reader.pdf_lab.worker import LocalWorkers
from wise_reader.store import _now

from .representation import build_representation
from .text_normalization import intersects_change
from .formulas import FormulaService
from .enhancements import EnhancementService
from .enhancement_publication import prepare_page as prepare_enhancement_page
from .uploads import MAX_PAGES, error, receive_original

log = logging.getLogger(__name__)
RANGE_PAGES = 8
MAX_REPAIRS = (MAX_PAGES + RANGE_PAGES - 1) // RANGE_PAGES


class PDFModule:
    def __init__(self, ctx, data_dir=None):
        self.store, self.engine = ctx.store, ctx.engine
        default = self.store.path.parent / (self.store.path.stem + "-pdf")
        self.originals = LabStore(Path(data_dir or os.environ.get("WR_PDF_DATA_DIR", default)))
        self.workers = LocalWorkers(self.originals, on_publish=self.on_publish,
                                    on_reconcile=self.on_reconcile)
        self.bridge_lock = asyncio.Lock()
        self.control_lock = asyncio.Lock()
        self.watcher = None
        self.closing = False
        self.started = False
        self.pending_repairs = {}
        self.reconcile_requests = {}
        self.reconcile_tokens = {}
        self.repair_attempts = {}
        self.bridge_errors = {}
        self.processing_seen = self.enabled()
        self.store.executescript("""
            CREATE TABLE IF NOT EXISTS wr_pdf_book (
                book_id INTEGER PRIMARY KEY, source_id TEXT NOT NULL UNIQUE,
                source_sha256 TEXT NOT NULL UNIQUE, lifecycle TEXT NOT NULL DEFAULT 'active',
                generation INTEGER NOT NULL DEFAULT 1, registered_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wr_pdf_range (
                book_id INTEGER NOT NULL, start_page INTEGER NOT NULL, end_page INTEGER NOT NULL,
                doc_id INTEGER NOT NULL UNIQUE, ready_pages TEXT NOT NULL, ready_count INTEGER NOT NULL,
                revision TEXT NOT NULL, published_at REAL NOT NULL,
                PRIMARY KEY(book_id, start_page)
            );
            CREATE TABLE IF NOT EXISTS wr_pdf_task_epoch (
                task_id TEXT PRIMARY KEY, book_id INTEGER NOT NULL, generation INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS wr_pdf_page (
                book_id INTEGER NOT NULL, page_number INTEGER NOT NULL, task_id TEXT NOT NULL,
                accepted_at REAL NOT NULL, PRIMARY KEY(book_id, page_number)
            );
            CREATE TABLE IF NOT EXISTS wr_pdf_revision (
                doc_id INTEGER NOT NULL, revision TEXT NOT NULL, title TEXT NOT NULL,
                text TEXT NOT NULL, blocks TEXT NOT NULL, retained_at TEXT NOT NULL,
                PRIMARY KEY(doc_id, revision)
            );
            CREATE TABLE IF NOT EXISTS wr_pdf_anchor_status (
                owner TEXT NOT NULL, owner_id INTEGER NOT NULL, doc_id INTEGER NOT NULL,
                version TEXT NOT NULL, state TEXT NOT NULL,
                PRIMARY KEY(owner, owner_id)
            );
            CREATE TABLE IF NOT EXISTS wr_pdf_archive_hold (
                doc_id INTEGER PRIMARY KEY, was_archived INTEGER NOT NULL
            );
        """)
        self.formulas = FormulaService(self)
        self.enhancements = EnhancementService(self)

    def enabled(self):
        return self.store.is_plugin_enabled("pdf", True)

    def mapping(self, book_id):
        return self.store.query_one("SELECT * FROM wr_pdf_book WHERE book_id=?", (book_id,))

    def source_book(self, book_id):
        mapping = self.mapping(book_id)
        source = self.originals.book(mapping["source_id"]) if mapping else None
        if not source:
            raise error(404, "book_not_found", "No registered PDF book has this identity.")
        return mapping, source

    def _ensure_book(self, source):
        with self.store.transaction():
            mapping = self.store.query_one("SELECT * FROM wr_pdf_book WHERE source_sha256=?",
                                           (source["file_sha256"],))
            if mapping:
                return mapping
            book_id = content.add_book(self.store, source["title"], source="pdf")
            self.store.execute("INSERT INTO wr_pdf_book(book_id,source_id,source_sha256,registered_at) VALUES(?,?,?,?)",
                (book_id, source["id"], source["file_sha256"], _now()))
            return self.mapping(book_id)

    def _bind_task(self, mapping, task):
        self.store.execute("INSERT OR REPLACE INTO wr_pdf_task_epoch VALUES(?,?,?)",
                           (task["id"], mapping["book_id"], mapping["generation"]))

    async def start(self):
        if self.started:
            return
        self.started = True
        await self.formulas.start()
        await self.enhancements.start()
        await self.workers.recover()
        for source in self.originals.books():
            mapping = await asyncio.to_thread(self._ensure_book, source)
            if mapping["lifecycle"] != "active":
                continue
            await asyncio.to_thread(self.seed_accepted_pages, mapping, source)
            ranges = {}
            for task in self.originals.tasks(source["id"]):
                epoch = self.store.query_one("SELECT * FROM wr_pdf_task_epoch WHERE task_id=?", (task["id"],))
                if not epoch:
                    self._bind_task(mapping, task)
                    epoch = {"generation": mapping["generation"]}
                if epoch["generation"] != mapping["generation"] or task["state"] not in {"completed", "partial", "paused"}:
                    continue
                for number in await asyncio.to_thread(self.workers.published_pages, task):
                    ranges[((number - 1) // RANGE_PAGES) * RANGE_PAGES + 1] = task["id"]
            for number, task_id in ranges.items():
                await self.publish_range(task_id, number, retained=True)
            self.enhancements.pages_available(mapping['book_id'], [
                (row['page_number'], row['task_id']) for row in self.store.query(
                    'SELECT page_number,task_id FROM wr_pdf_page WHERE book_id=?', (mapping['book_id'],))])
        self.watcher = asyncio.create_task(self.watch_processing())

    def seed_accepted_pages(self, mapping, source):
        """One-time migration records only source pages already present in reader rows."""
        tasks = self.originals.tasks(source["id"])
        numbers = {t["id"]: set(self.workers.published_pages(t)) for t in tasks}
        for scope in self.store.query("SELECT * FROM wr_pdf_range WHERE book_id=?", (mapping["book_id"],)):
            for number in json.loads(scope["ready_pages"]):
                if self.store.query_one("SELECT page_number FROM wr_pdf_page WHERE book_id=? AND page_number=?", (mapping["book_id"], number)):
                    continue
                candidates = [t for t in tasks if t["created_at"] <= scope["published_at"] and number in numbers[t["id"]]]
                if candidates:
                    self.store.execute("INSERT OR IGNORE INTO wr_pdf_page VALUES(?,?,?,?)",
                        (mapping["book_id"], number, candidates[-1]["id"], scope["published_at"]))

    async def close(self):
        self.closing = True
        if self.watcher:
            self.watcher.cancel()
            await asyncio.gather(self.watcher, return_exceptions=True)
        await self.formulas.close()
        await self.enhancements.close()
        await self.workers.close()

    async def watch_processing(self):
        while not self.closing:
            await asyncio.sleep(0.5)
            enabled = await asyncio.to_thread(self.enabled)
            if enabled != self.processing_seen:
                await self.processing_changed(enabled)
            if enabled:
                self._fill_bridge_repairs()
                await self.enhancements.tick()
            if enabled and self.pending_repairs:
                key = next(iter(self.pending_repairs))
                item = self.pending_repairs[key]
                try:
                    status = await self.publish_range(key[0], key[1],
                                                     expected_generation=item['generation'])
                except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
                    if self.pending_repairs.get(key) is item:
                        self.pending_repairs.pop(key)
                    self.record_bridge_failure(key[0], key[1], exc, retry=True)
                else:
                    # A new reconciliation may have arrived while this scope
                    # was being prepared. Retire only the item we consumed.
                    if self.pending_repairs.get(key) is item:
                        self.pending_repairs.pop(key)
                        if status == 'deferred':
                            self.pending_repairs[key] = item  # rotate queued work fairly

    async def processing_changed(self, enabled):
        async with self.control_lock:
            enabled = await asyncio.to_thread(self.enabled)
            if self.processing_seen == enabled:
                return
            self.processing_seen = enabled
            if not enabled:
                await asyncio.to_thread(self.store.execute,
                    "UPDATE wr_pdf_book SET generation=generation+1 WHERE lifecycle='active'")
                await self.formulas.processing_changed(False)
                await self.enhancements.processing_changed(False)
                for source in await asyncio.to_thread(self.originals.books):
                    await self.workers.pause_book(source["id"], "processing_disabled")

    async def set_enabled(self, enabled):
        if await asyncio.to_thread(self.enabled) != enabled:
            await asyncio.to_thread(self.store.set_plugin_enabled, "pdf", enabled)
        await self.processing_changed(enabled)

    async def set_processing_enabled(self, enabled):
        await self.set_enabled(enabled)

    def task_payload(self, source):
        task = self.originals.task(source["latest_task_id"])
        mapping = self.store.query_one("SELECT book_id FROM wr_pdf_book WHERE source_id=?", (source["id"],))
        return {**{k: v for k, v in task.items() if k != "pid"},
                "book_id": mapping["book_id"] if mapping else None, "source_id": source["id"]}

    def metadata(self, mapping, source, scope=None):
        book_id = mapping["book_id"]
        totals = self.store.query_one("SELECT COALESCE(SUM(ready_count),0) AS ready_count FROM wr_pdf_range WHERE book_id=?", (book_id,))
        first = self.store.query_one("SELECT doc_id FROM wr_pdf_range WHERE book_id=? AND ready_count>0 ORDER BY start_page LIMIT 1", (book_id,))
        latest = scope or self.store.query_one("SELECT revision FROM wr_pdf_range WHERE book_id=? ORDER BY published_at DESC LIMIT 1", (book_id,))
        payload = {"book_id": book_id, "source_id": source["id"], "source_sha256": source["file_sha256"],
            "page_count": source["page_count"], "start_page": scope["start_page"] if scope else 1,
            "end_page": scope["end_page"] if scope else source["page_count"],
            "ready_pages": scope["ready_count"] if scope else totals["ready_count"],
            "reading_doc_id": first["doc_id"] if first else None,
            "source_url": f"/api/pdf/books/{book_id}/source", "status_url": f"/api/pdf/books/{book_id}",
            "revision": latest["revision"] if latest else "", "processing_enabled": self.enabled(),
            "lifecycle": mapping["lifecycle"], "task": self.task_payload(source), "quality_reviewed": False}
        payload["ranges"] = self.store.query(
            "SELECT doc_id,start_page,end_page,revision,ready_count FROM wr_pdf_range WHERE book_id=? ORDER BY start_page", (book_id,))
        if scope:
            payload["ready_page_numbers"] = json.loads(scope["ready_pages"])
            count = self.store.query_one("SELECT COUNT(*) AS n FROM wr_pdf_anchor_status WHERE doc_id=? AND state='uncertain'", (scope["doc_id"],))
            payload["mapping_uncertain_count"] = count["n"]
        if book_id in self.bridge_errors:
            payload["bridge_error"] = self.bridge_errors[book_id]
        return payload

    def document_metadata(self, doc_id):
        scope = self.store.query_one("SELECT * FROM wr_pdf_range WHERE doc_id=?", (doc_id,))
        if not scope:
            return None
        mapping, source = self.source_book(scope["book_id"])
        return self.metadata(mapping, source, scope)

    def resume_position(self, doc_id, anchor, version):
        """Read-only cold resume proof; never updates semantic saved references."""
        from .text_normalization import reading_position
        scope = self.store.query_one("SELECT * FROM wr_pdf_range WHERE doc_id=?", (doc_id,))
        current = self.store.query_one("SELECT version,blocks FROM wr_content WHERE doc_id=?", (doc_id,))
        if not scope or not current or current['version'] != version:
            return None
        if not isinstance(anchor.get('version'), str):
            return None
        retained = self.store.query_one("SELECT blocks FROM wr_pdf_revision WHERE doc_id=? AND revision=?",
                                        (doc_id, anchor.get('version')))
        if not retained:
            return None
        mapping, source = self.source_book(scope['book_id'])
        if mapping['lifecycle'] != 'active':
            return None
        try:
            return reading_position(anchor, json.loads(retained['blocks']),
                                    json.loads(current['blocks']), version,
                                    scope['book_id'], source['file_sha256'])
        except (ValueError, TypeError):
            return None

    def prepare_document(self, doc_id):
        # Background publication prepared lexical analysis before the short commit.
        return self.document_metadata(doc_id)

    def decorate_book(self, book_payload):
        if not book_payload or book_payload.get("source") != "pdf":
            return book_payload
        mapping = self.mapping(book_payload["id"])
        if not mapping:
            return book_payload
        source = self.originals.book(mapping["source_id"])
        return {**book_payload, "pdf": self.metadata(mapping, source)}

    def visible(self, book_id):
        mapping = self.mapping(book_id)
        return not mapping or mapping["lifecycle"] == "active"

    def book_payload(self, book_id):
        mapping, source = self.source_book(book_id)
        book = self.store.query_one("SELECT * FROM wr_book WHERE id=?", (book_id,))
        chapters = self.store.query("SELECT c.*,d.word_count FROM wr_chapter c JOIN document d ON d.id=c.doc_id WHERE c.book_id=? ORDER BY c.idx", (book_id,))
        return {**book, "book_id": book_id, "chapters": chapters,
                "pdf": self.metadata(mapping, source), "task": self.task_payload(source)}

    def recycled_books(self):
        return [self.book_payload(row["book_id"]) for row in self.store.query(
            "SELECT book_id FROM wr_pdf_book WHERE lifecycle='recycled' ORDER BY book_id DESC")]

    async def capabilities(self):
        # This endpoint is the import dialog's explicit status/refresh boundary.
        payload = await self.workers.capabilities(fresh=True)
        return {**payload, "processing_enabled": self.enabled(), "cloud_enabled": False,
                "supported_actions": ["convert", "pause", "resume", "cancel", "recognize"] if self.enabled() else ["pause", "cancel"],
                "supports_region": False, "reading_range_pages": RANGE_PAGES}

    async def import_file(self, file, engine="auto"):
        # Selecting a named location is the user's authorization for this file.
        # The default remains this computer; configuring a host never opts in.
        if engine not in {"auto", "digital", "docling", "omarchy", "mineru_source"}:
            await file.close()
            raise error(422, "unsupported_engine", "Choose a supported PDF processing location.")
        if not self.enabled():
            await file.close()
            raise error(409, "processing_disabled", "PDF processing is disabled; retained books remain readable.")
        began = time.monotonic()
        try:
            temporary, title, digest, size, count = await receive_original(
                file, self.originals.root, reclaim=self.engine._source_cache.reclaim)
        except OSError as exc:
            raise error(507 if exc.errno == 28 else 500, "storage_failed", "Local PDF receipt failed.")
        try:
            source, task, reused = await asyncio.to_thread(self.originals.register,
                temporary, title, digest, size, count, (time.monotonic() - began) * 1000)
            async with self.control_lock:
                source = self.originals.book(source["id"])
                task = self.originals.task(source["latest_task_id"])
                mapping = await asyncio.to_thread(self._ensure_book, source)
                if not reused and mapping["lifecycle"] == "active" and self.enabled():
                    task, failure = await self.workers.start(source, engine, 1, count)
                    if failure:
                        task = self.originals.update(source["latest_task_id"], state="preparing", engine=engine, error=failure)
                    self._bind_task(mapping, task)
                    if not self.enabled():
                        await self.workers.pause_book(source["id"], "processing_disabled")
                else:
                    if not self.store.query_one("SELECT task_id FROM wr_pdf_task_epoch WHERE task_id=?", (task["id"],)):
                        self._bind_task(mapping, task)
            payload = self.book_payload(mapping["book_id"])
            return {**payload, "reused": reused, "notice": "原件已保存；阅读版按真实完成范围逐步开放。"}, reused
        except OSError as exc:
            raise error(507 if exc.errno == 28 else 500, "storage_failed", "Local PDF storage failed.")
        except sqlite3.Error:
            raise error(500, "registration_failed", "PDF registration could not be committed.")
        finally:
            temporary.unlink(missing_ok=True)

    async def on_publish(self, task_id, page_number):
        try:
            await self.publish_range(task_id, page_number)
        except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
            self.record_bridge_failure(task_id, page_number, exc)
            raise

    async def on_reconcile(self, task_id):
        task = self.originals.task(task_id)
        if task is not None:
            await self.queue_bridge_repair(task)

    def record_bridge_failure(self, task_id, page_number, exc, retry=False):
        task = self.originals.task(task_id)
        mapping = self.store.query_one("SELECT book_id,generation FROM wr_pdf_book WHERE source_id=?", (task["book_id"],))
        key = (task_id, ((page_number - 1) // RANGE_PAGES) * RANGE_PAGES + 1)
        attempts = self.repair_attempts.get(key, 0) + (1 if retry else 0)
        self.repair_attempts[key] = attempts
        if mapping and attempts < 2 and (key in self.pending_repairs or len(self.pending_repairs) < MAX_REPAIRS):
            self.pending_repairs[key] = {'generation': mapping['generation']}
        if mapping:
            self.bridge_errors[mapping["book_id"]] = {"code": "reading_representation_unavailable",
                "message": str(exc)[:500], "task_id": task_id, "start_page": key[1], "attempts": attempts,
                "notice": "保留页资料仍在；可重新执行转换操作修复阅读表示，不重新OCR已有范围。"}
        log.warning("PDF reading publication failed for %s page %s: %s", task_id, page_number, exc)

    async def queue_bridge_repair(self, task):
        mapping = self.store.query_one("SELECT generation,lifecycle FROM wr_pdf_book WHERE source_id=?", (task['book_id'],))
        epoch = self.store.query_one("SELECT generation FROM wr_pdf_task_epoch WHERE task_id=?", (task['id'],))
        if not mapping or mapping['lifecycle'] != 'active' or not epoch or epoch['generation'] != mapping['generation']:
            return
        token = object()
        self.reconcile_tokens[task['id']] = token
        try:
            numbers = await asyncio.to_thread(self.workers.published_pages, task)
        except BaseException:
            if self.reconcile_tokens.get(task['id']) is token:
                self.reconcile_tokens.pop(task['id'])
            raise
        if self.reconcile_tokens.get(task['id']) is not token:
            return  # a newer resume/finish reconciliation owns this task
        self.reconcile_tokens.pop(task['id'])
        current = self.store.query_one("SELECT generation,lifecycle FROM wr_pdf_book WHERE source_id=?", (task['book_id'],))
        if not current or current['lifecycle'] != 'active' or current['generation'] != mapping['generation']:
            return
        scopes = sorted({((number - 1) // RANGE_PAGES) * RANGE_PAGES + 1 for number in numbers})
        # Keep a cursor when the bounded work queue is full; no published range
        # may disappear merely because another book occupies the queue.
        self.reconcile_requests[task['id']] = (mapping['generation'], iter(scopes))
        self._fill_bridge_repairs()

    def _fill_bridge_repairs(self):
        while self.reconcile_requests and len(self.pending_repairs) < MAX_REPAIRS:
            task_id = next(iter(self.reconcile_requests))
            generation, scopes = self.reconcile_requests[task_id]
            number = next(scopes, None)
            if number is None:
                self.reconcile_requests.pop(task_id)
                continue
            key = (task_id, number)
            self.repair_attempts[key] = 0
            self.pending_repairs[key] = {'generation': generation}

    def _read_representation(self, mapping, source, start, end, candidate):
        accepted = self.store.query("SELECT * FROM wr_pdf_page WHERE book_id=? AND page_number BETWEEN ? AND ?",
                                    (mapping["book_id"], start, end))
        tasks = {t["id"]: t for t in self.originals.tasks(source["id"])}
        pages = {}
        results = {}
        for task_id in {r["task_id"] for r in accepted} | {candidate["id"]}:
            if task_id not in tasks:
                raise ValueError("Accepted source-page task is missing; prior reader content retained.")
            result = self.workers.result(source, start, end, task_ids={task_id})
            results[task_id] = result
            for page in result["pages"]:
                number = page["page_number"]
                ledger = next((r for r in accepted if r["page_number"] == number), None)
                if ledger and ledger["task_id"] == task_id:
                    pages[number] = page
        for page in results[candidate["id"]]["pages"]:
            number = page["page_number"]
            ledger = next((r for r in accepted if r["page_number"] == number), None)
            if ledger and (self.enhancements.task_intent_time(tasks[ledger["task_id"]])
                           > self.enhancements.task_intent_time(candidate)):
                continue  # resumed base work cannot replace a newer localized result
            if (page["blocks"] or page["text"].strip()) and page.get("quality_state") != "rejected":
                pages[number] = page
        if any(r["page_number"] not in pages for r in accepted):
            raise ValueError("Previously accepted source-page material is unavailable; prior reader content retained.")
        result = {"pages": [pages[n] for n in sorted(pages)]}
        prefix = f"/api/pdf-lab/books/{source['id']}/"
        for page in result["pages"]:
            for block in page["blocks"]:
                # Inline formulas are registered task assets just like figures.
                # Rewrite only the declared resources, never arbitrary strings.
                for item in [block, *block.get("inline_objects", [])]:
                    asset = item.get("asset_url")
                    if asset:
                        if not asset.startswith(prefix):
                            raise ValueError("Published resource does not belong to this original.")
                        item["asset_url"] = f"/api/pdf/books/{mapping['book_id']}/" + asset[len(prefix):]
        text, blocks, revision = build_representation(result["pages"], mapping["book_id"], source["file_sha256"])
        return text, blocks, revision, [(p["page_number"], p["conversion_task_id"]) for p in result["pages"]
            if (p["blocks"] or p["text"].strip()) and p.get("quality_state") != "rejected"]

    async def publish_range(self, task_id, page_number, retained=False, *, expected_generation=None, publication_guard=None):
        """Return done/deferred/stale so queued repairs cannot be silently lost."""
        async with self.bridge_lock:
            task = self.originals.task(task_id)
            mapping = self.store.query_one("SELECT * FROM wr_pdf_book WHERE source_id=?", (task["book_id"],))
            if not mapping or mapping["lifecycle"] != "active" or self.closing:
                return 'stale'
            if expected_generation is not None and mapping['generation'] != expected_generation:
                return 'stale'
            epoch = self.store.query_one("SELECT * FROM wr_pdf_task_epoch WHERE task_id=?", (task_id,))
            allowed = {"running", "completed", "partial"} | ({"paused"} if retained else set())
            if not epoch or epoch["generation"] != mapping["generation"] or not self.enabled():
                return 'stale'
            if task["engine"] == "external_vision":
                # Recovery/reconciliation must honor the same retained authorization
                # as immediate publication, including cancelled or superseded results.
                job_id = (task.get("metrics") or {}).get("enhancement_job_id")
                supplied_guard = publication_guard
                def enhancement_guard():
                    return bool(job_id and self.enhancements.publication_allowed(
                        {"id": job_id, "generation": epoch["generation"]})
                        and (supplied_guard is None or supplied_guard()))
                publication_guard = enhancement_guard
                if not publication_guard():
                    return 'stale'
            if task['state'] in {'queued', 'preparing'}:
                return 'deferred'
            if task['state'] not in allowed:
                return 'stale'
            source = self.originals.book(task["book_id"])
            start = ((page_number - 1) // RANGE_PAGES) * RANGE_PAGES + 1
            end = min(source["page_count"], start + RANGE_PAGES - 1)
            text, blocks, revision, accepted = await asyncio.to_thread(self._read_representation, mapping, source, start, end, task)
            ready = [p[0] for p in accepted]
            if not blocks or not ready:
                return 'done'
            old = self.store.query_one("SELECT * FROM wr_pdf_range WHERE book_id=? AND start_page=?", (mapping["book_id"], start))
            if old and old["revision"] == revision:
                self.clear_bridge_failure(mapping["book_id"], task_id, start)
                self.enhancements.pages_available(mapping['book_id'], accepted)
                return 'done'
            title = self.store.query_one("SELECT title FROM wr_book WHERE id=?", (mapping["book_id"],))["title"]
            prepared = await asyncio.to_thread(self.engine.prepare_import, f"{title} · 原页 {start}–{end}", text, blocks)
            prepared["version"] = revision
            anchors = self.store.query("SELECT * FROM wr_anchor WHERE doc_id=?", (old["doc_id"],)) if old else []
            states = await asyncio.to_thread(self.anchor_states, anchors, blocks, revision)
            committed = await asyncio.to_thread(self._commit_range, mapping, task_id, prepared, start, end, accepted, states, retained, publication_guard)
            if committed:
                self.clear_bridge_failure(mapping["book_id"], task_id, start)
                self.enhancements.pages_available(mapping['book_id'], accepted)
                return 'done'
            return 'deferred'  # recheck lifecycle after a concurrent pause/resume

    def clear_bridge_failure(self, book_id, task_id, start):
        key = (task_id, start)
        self.repair_attempts.pop(key, None)
        failure = self.bridge_errors.get(book_id)
        if failure and failure["task_id"] == task_id and failure["start_page"] == start:
            self.bridge_errors.pop(book_id, None)

    @staticmethod
    def anchor_states(anchors, blocks, revision):
        states = []
        for record in anchors:
            anchor = json.loads(record["payload"])
            quote = anchor.get("quote", "")
            old_source = anchor.get("pdf_source") or {}
            candidates = [b for b in blocks if old_source.get("source_sha256")
                and old_source["source_sha256"] == b["source"].get("source_sha256")
                and old_source.get("page_number") == b["source"].get("page_number")
                and old_source.get("bbox") == b["source"].get("bbox")]
            if anchor.get("kind") == "image":
                candidates = [b for b in candidates if b["type"] in {"image", "image_fallback"}]
                reliable = len(candidates) == 1
            else:
                candidates = [b for b in candidates if b["type"] not in {"image", "image_fallback"}]
                reliable = bool(quote and sum(b["text"].count(quote) for b in candidates) == 1)
                if reliable:
                    candidate = next(b for b in candidates if quote in b["text"])
                    start = candidate["text"].index(quote)
                    reliable = not intersects_change(candidate, start, start + len(quote))
            states.append((record["owner"], record["owner_id"], record["doc_id"], revision,
                           "mapped" if reliable else "uncertain"))
        return states

    def _commit_range(self, expected, task_id, prepared, start, end, accepted, states, retained, publication_guard=None):
        with self.store.transaction():
            if publication_guard is not None and not publication_guard():
                return
            current = self.mapping(expected["book_id"])
            task = self.originals.task(task_id)
            epoch = self.store.query_one("SELECT * FROM wr_pdf_task_epoch WHERE task_id=?", (task_id,))
            if not current or current["lifecycle"] != "active" or self.closing:
                return
            allowed = {"running", "completed", "partial"} | ({"paused"} if retained else set())
            if (not self.enabled() or current["generation"] != expected["generation"]
                                 or not epoch or epoch["generation"] != current["generation"]
                                 or task["state"] not in allowed):
                return
            previous = self.store.query_one("SELECT * FROM wr_pdf_range WHERE book_id=? AND start_page=?", (current["book_id"], start))
            if previous:
                doc_id = previous["doc_id"]
                old = self.store.query_one("SELECT d.title,d.text,c.blocks FROM document d JOIN wr_content c ON c.doc_id=d.id WHERE d.id=?", (doc_id,))
                self.store.execute("INSERT OR IGNORE INTO wr_pdf_revision VALUES(?,?,?,?,?,?)",
                    (doc_id, previous["revision"], old["title"], old["text"], old["blocks"], _now()))
                row = prepared["row"]
                self.store.execute("UPDATE document SET title=?,text=?,word_count=?,text_hash=?,l0_json=?,l1_json=? WHERE id=?",
                    tuple(row[k] for k in ("title", "text", "word_count", "text_hash", "l0_json", "l1_json")) + (doc_id,))
                self.store.execute("UPDATE wr_content SET version=?,blocks=? WHERE doc_id=?", (prepared["version"], prepared["blocks"], doc_id))
                self.engine._source_cache.save_prepared({**row, "id": doc_id}, prepared["analysis"], prepared["cache_key"])
                self.store.execute("UPDATE wr_chapter SET title=? WHERE doc_id=?", (row["title"], doc_id))
            else:
                document = self.engine.persist_import(prepared)
                doc_id = document["id"]
                content.add_chapter(self.store, current["book_id"], (start - 1) // RANGE_PAGES,
                                    prepared["row"]["title"], doc_id)
            self.store.execute("INSERT OR REPLACE INTO wr_pdf_range VALUES(?,?,?,?,?,?,?,?)",
                (current["book_id"], start, end, doc_id, json.dumps([p[0] for p in accepted]), len(accepted), prepared["version"], time.time()))
            for number, source_task_id in accepted:
                self.store.execute("INSERT OR REPLACE INTO wr_pdf_page VALUES(?,?,?,?)",
                    (current["book_id"], number, source_task_id, time.time()))
            for state in states:
                self.store.execute("INSERT OR REPLACE INTO wr_pdf_anchor_status VALUES(?,?,?,?,?)", state)
            return True

    async def apply_enhancement(self, job, page):
        """Called under the service's control lock; never expand the source scope."""
        def allowed():
            mapping = self.mapping(job["book_id"])
            return bool(mapping and mapping["lifecycle"] == "active"
                and mapping["source_sha256"] == job["source_sha256"]
                and mapping["generation"] == job["generation"]
                and self.enabled() and not self.closing
                and self.enhancements.publication_allowed(job))
        if not allowed():
            return "stale"
        preparation = asyncio.create_task(asyncio.to_thread(prepare_enhancement_page, self, job, page))
        try:
            task = await asyncio.shield(preparation)
        except asyncio.CancelledError:
            # The preparation thread cannot be cancelled. Join it before
            # retiring its task so it cannot leave a late running record.
            task = await preparation
            if task is not None:
                self.originals.update(task['id'], state='cancelled')
            raise
        if task is None:
            return "deferred"
        if not allowed():
            self.originals.update(task["id"], state="cancelled")
            return "stale"
        try:
            self._bind_task(self.mapping(job["book_id"]), task)
            self.originals.update(task["id"], state="running")
            published = await asyncio.to_thread(self.workers.publish, task)
            self.originals.update(task["id"], state="completed", metrics={**published["metrics"], "enhancement_job_id": job["id"]})
            return await self.publish_range(task["id"], page["page_number"],
                expected_generation=job["generation"], publication_guard=allowed)
        except BaseException as exc:
            self.originals.update(task['id'], state='cancelled' if isinstance(exc, asyncio.CancelledError) else 'failed',
                error={'code': 'enhancement_publication_failed', 'message': 'Publication did not complete; retained material remains available.'})
            raise

    async def operate(self, book_id, action, engine="auto", start_page=None, end_page=None, region=None):
        async with self.control_lock:
            mapping, source = self.source_book(book_id)
            task = self.originals.task(source["latest_task_id"])
            if action in {"convert", "recognize", "resume"}:
                if not self.enabled():
                    raise error(409, "processing_disabled", "Enable PDF processing before starting local work.")
                if mapping["lifecycle"] != "active":
                    raise error(409, "book_recycled", "Restore this PDF before starting work.")
            if action in {"convert", "recognize"}:
                if region is not None:
                    raise error(422, "region_not_supported", "Region recognition is unavailable; choose explicit original pages.")
                if action == "recognize" and start_page is None:
                    raise error(422, "scope_required", "Choose the original page(s) to recognize.")
                start = start_page or 1
                end = end_page if end_page is not None else (start if action == "recognize" else source["page_count"])
                if not 1 <= start <= end <= source["page_count"]:
                    raise error(422, "invalid_range", "Requested pages leave this PDF.")
                if engine == "omarchy" and (start, end) != (1, source["page_count"]):
                    raise error(409, "omarchy_scope_unsupported",
                                "Omarchy 目前仅支持整书处理；局部重新识别请选择当前电脑。")
                cached = next((t for t in reversed(self.originals.tasks(source["id"]))
                    if t["state"] == "completed" and (t["engine"], t["start_page"], t["end_page"]) == (engine, start, end)), None)
                if action == "convert" and cached and len(await asyncio.to_thread(self.workers.published_pages, cached)) == cached["total_pages"]:
                    self.originals.select_task(source["id"], cached["id"])
                    task, failure = cached, None
                else:
                    task, failure = await self.workers.start(source, engine, start, end, force=action == "recognize")
                if failure:
                    raise error(422 if failure["code"] == "unsupported_engine" else 409 if failure["code"] in {"task_conflict", "omarchy_scope_unsupported"} else 503,
                                failure["code"], failure["message"])
                self._bind_task(mapping, task)
                if task["state"] == "completed":
                    await self.queue_bridge_repair(task)
            elif action == "pause":
                self.store.execute("UPDATE wr_pdf_book SET generation=generation+1 WHERE book_id=?", (book_id,))
                task = await self.workers.pause(task)
            elif action == "resume":
                if task["state"] == "completed":
                    unfinished = [t for t in self.originals.tasks(source["id"])
                                  if t["state"] in {"paused", "partial", "failed", "preparing"}]
                    if unfinished:
                        task = unfinished[-1]
                self._bind_task(mapping, task)
                task, failure = await self.workers.resume(task)
                if failure:
                    raise error(409, failure["code"], failure["message"])
            elif action == "cancel":
                await self.enhancements.cancel_book(book_id)
                self.store.execute("UPDATE wr_pdf_book SET generation=generation+1 WHERE book_id=?", (book_id,))
                task = await self.workers.cancel(task)
            else:
                raise error(422, "unknown_action", "Unknown PDF operation.")
            if action in {"convert", "recognize", "resume"} and not self.enabled():
                await self.workers.pause_book(source["id"], "processing_disabled")
            return self.book_payload(book_id)

    async def recycle_book(self, book_id):
        return await self.lifecycle(book_id, "recycle")

    async def lifecycle(self, book_id, action):
        async with self.control_lock:
            mapping, source = self.source_book(book_id)
            if action not in {"recycle", "restore"}:
                raise error(422, "unknown_action", "Choose recycle or restore.")
            wanted = "recycled" if action == "recycle" else "active"
            if mapping["lifecycle"] == wanted:
                return self.book_payload(book_id)
            with self.store.transaction():
                self.store.execute("UPDATE wr_pdf_book SET lifecycle=?,generation=generation+1 WHERE book_id=?", (wanted, book_id))
                if action == "recycle":
                    for row in self.store.query("SELECT doc_id FROM wr_pdf_range WHERE book_id=?", (book_id,)):
                        archived = self.store.query_one("SELECT doc_id FROM wr_archive WHERE doc_id=?", (row["doc_id"],))
                        self.store.execute("INSERT OR IGNORE INTO wr_pdf_archive_hold VALUES(?,?)", (row["doc_id"], bool(archived)))
                        self.store.execute("INSERT OR IGNORE INTO wr_archive VALUES(?,?)", (row["doc_id"], _now()))
                else:
                    for row in self.store.query("SELECT h.* FROM wr_pdf_archive_hold h JOIN wr_pdf_range r ON r.doc_id=h.doc_id WHERE r.book_id=?", (book_id,)):
                        if not row["was_archived"]:
                            self.store.execute("DELETE FROM wr_archive WHERE doc_id=?", (row["doc_id"],))
                        self.store.execute("DELETE FROM wr_pdf_archive_hold WHERE doc_id=?", (row["doc_id"],))
            await self.formulas.cancel_book(book_id)
            await self.enhancements.cancel_book(book_id)
            await self.workers.pause_book(source["id"], "book_recycled" if action == "recycle" else "book_restored")
            return self.book_payload(book_id)
