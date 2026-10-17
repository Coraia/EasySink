"""Opt-in local evidence. No inference, history backfill, network, or TTL.

V12-B-TRANSACTION-ISOLATION-R1: business commits first. Immutable allowlisted
snapshots enter a bounded volatile queue; only an independent evidence database
commit is durable. An unacknowledged process tail is always unknown/gap.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import time
import uuid
from collections import deque
from contextlib import contextmanager
from threading import RLock, Event, Thread
from fastapi import HTTPException

SCHEMA = 1
LIMIT = 256 * 1024 * 1024
DAYS = 90 * 86400
# Client queue (512KiB), server queue (512KiB), in-flight batch (256KiB),
# plus conservative bookkeeping margin; all count toward the same 256MiB cap.
QUEUE_RESERVE = 2 * 1024 * 1024
IDENTITY = re.compile(r"[A-Za-z0-9:_-]{1,128}\Z")


def packed(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True, allow_nan=False)


def identity(value):
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise HTTPException(422, "invalid evidence identity")
    return value


def migrate(store):
    store.executescript("""
    CREATE TABLE IF NOT EXISTS wr_evidence_control (
      id INTEGER PRIMARY KEY CHECK(id=1), library_id TEXT NOT NULL, epoch TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0, started REAL, clock REAL NOT NULL,
      charged INTEGER NOT NULL DEFAULT 0, pause TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS wr_evidence_context (
      hash TEXT PRIMARY KEY, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wr_evidence_event (
      ordinal INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL, session_seq INTEGER NOT NULL, operation_id TEXT,
      epoch TEXT NOT NULL, received REAL NOT NULL, context_hash TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wr_evidence_event_session ON wr_evidence_event(session_id,session_seq);
    CREATE UNIQUE INDEX IF NOT EXISTS wr_evidence_client_sequence ON wr_evidence_event(session_id,session_seq) WHERE session_seq>0;
    CREATE TABLE IF NOT EXISTS wr_evidence_undo (
      token_hash TEXT PRIMARY KEY, operation_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wr_evidence_session (
      session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, first_seen REAL NOT NULL,
      last_seen REAL NOT NULL, closed INTEGER NOT NULL DEFAULT 0
    );
    """)
    store.execute("INSERT OR IGNORE INTO wr_evidence_control(id,library_id,epoch,clock) VALUES(1,?,?,?)",
                  (uuid.uuid4().hex, uuid.uuid4().hex, time.time()))


class EvidenceStore:
    """Evidence-only connection/file. Never shares a transaction with Store."""
    def __init__(self, path):
        self.path = path
        self.lock = RLock()
        self.depth = 0
        self.con = sqlite3.connect(str(path), check_same_thread=False, timeout=0.25)
        self.con.row_factory = sqlite3.Row
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.execute("PRAGMA synchronous=FULL")
        migrate(self)

    def executescript(self, sql):
        with self.lock:
            self.con.executescript(sql)

    def execute(self, sql, params=()):
        with self.lock:
            result = self.con.execute(sql, params)
            if not self.depth:
                self.con.commit()
            return result

    def query(self, sql, params=()):
        with self.lock:
            return [dict(r) for r in self.con.execute(sql, params).fetchall()]

    def query_one(self, sql, params=()):
        rows = self.query(sql, params)
        return rows[0] if rows else None

    @contextmanager
    def transaction(self):
        with self.lock:
            self.depth += 1
            try:
                yield
                if self.depth == 1:
                    self.con.commit()
            except BaseException:
                if self.depth == 1:
                    self.con.rollback()
                raise
            finally:
                self.depth -= 1

    def close(self):
        with self.lock:
            self.con.close()


def evidence_path(path):
    """Keep a legacy sidecar unless a same-stem business DB makes it ambiguous."""
    legacy = path.with_suffix(".evidence.sqlite3")
    suffix = path.suffix.lower()
    sibling_suffix = ".sqlite3" if suffix == ".db" else ".db" if suffix == ".sqlite3" else None
    sibling = path.with_suffix(sibling_suffix) if sibling_suffix else None
    if sibling is not None and sibling.exists():
        # Never guess which same-stem library owns the old sidecar. Preserve it
        # untouched and give each live library a name derived from its full name.
        return path.with_name(path.name + ".evidence.sqlite3")
    return legacy


class Evidence:
    def __init__(self, store, *, autostart=True):
        self.business_store = store
        self.store = EvidenceStore(evidence_path(store.path))
        self.fault = ""
        self._queue = deque()
        self._queue_bytes = 0
        self._queue_lock = RLock()
        self._flush_lock = RLock()
        self._wake = Event()
        self._stop = Event()
        self._worker = None
        # Cached consent is only populated from committed status/control. Producer
        # capture never reads or writes SQLite on the reader's critical path.
        self._consent = None
        self._clock_seen = self._state()['clock']
        if autostart:
            self._worker = Thread(target=self._run, name="reading-evidence", daemon=True)
            self._worker.start()

    def _run(self):
        while not self._stop.is_set():
            self._wake.wait(2)
            self._wake.clear()
            if not self._stop.is_set():
                self.flush()

    def flush(self):
        """Drain bounded batches, with no retry of a business/model operation."""
        with self._flush_lock:
            while True:
                with self._queue_lock:
                    if not self._queue or self.fault:
                        return
                    epoch = self._queue[0][0]
                    batch, size = [], 0
                    while self._queue and len(batch) < 32 and self._queue[0][0] == epoch:
                        item = self._queue[0]
                        if batch and size + len(item[1]) > 256 * 1024:
                            break
                        batch.append(self._queue.popleft())
                        size += len(item[1])
                        self._queue_bytes -= len(item[1])
                try:
                    with self.store.transaction():
                        events = [json.loads(raw) for _, raw, _ in batch]
                        pending_links = {}
                        for (_, _, created_token), event in zip(batch, events):
                            token = event['details'].pop('_undo_hash', None)
                            if token:
                                linked = self.store.query_one('SELECT operation_id FROM wr_evidence_undo WHERE token_hash=?', (token,))
                                event['details']['undo_of'] = pending_links.get(token) or (linked['operation_id'] if linked else 'unknown/pre-collection')
                            if created_token:
                                pending_links[created_token] = event['operation_id']
                        ack = self._append(epoch, events)
                        if ack.get('durable'):
                            for (_, _, token), event in zip(batch, events):
                                if token:
                                    self.store.execute('INSERT OR IGNORE INTO wr_evidence_undo VALUES(?,?)', (token, event['operation_id']))
                    # Only here has SQLite COMMIT acknowledged these events.
                except HTTPException:
                    # A closed/cleared epoch or identity conflict is not durable.
                    # Invalid old epochs are discarded; conflicts pause visibly.
                    try:
                        if epoch == self._state()['epoch']:
                            self.fault = 'capture-identity-conflict'
                    except Exception:
                        self.fault = 'capture-storage-failure'
                except Exception:
                    self.fault = 'capture-storage-failure'

    def close(self):
        self._stop.set()
        self._wake.set()
        if self._worker:
            self._worker.join()
        self.flush()
        self.store.close()

    def _state(self):
        state = self.store.query_one("SELECT * FROM wr_evidence_control WHERE id=1")
        if state is None:
            raise RuntimeError("evidence control unavailable")
        return state

    def usage(self, state):
        # Physical files include live/dead SQLite pages, all indexes, WAL and SHM.
        # Count logical pages too: newly allocated pages may not yet be in WAL.
        paths = [self.store.path, self.store.path.with_name(self.store.path.name + '-wal'),
                 self.store.path.with_name(self.store.path.name + '-shm')]
        sizes = []
        for path in paths:
            try:
                sizes.append(path.stat().st_size)
            except FileNotFoundError:
                sizes.append(0)
        page_counts = self.store.query_one('PRAGMA page_count')
        page_sizes = self.store.query_one('PRAGMA page_size')
        if not page_counts or not page_sizes:
            raise RuntimeError('evidence size unavailable')
        page_count, page_size = page_counts['page_count'], page_sizes['page_size']
        disk = max(sizes[0], page_count * page_size) + sum(sizes[1:])
        accounted = max(state['charged'], disk) + QUEUE_RESERVE
        return {'disk_bytes': disk, 'accounted_bytes': accounted,
                'accounting': 'max(conservative record charge, SQLite pages+WAL+SHM) + bounded queue reserve'}

    def _time(self, state):
        wall = time.time()
        high = max(state['clock'], self._clock_seen)
        # Fail closed on a material backward jump, rather than extending the window.
        regressed = wall < high - 1
        self._clock_seen = max(wall, high)
        return self._clock_seen, regressed

    def status(self):
        with self.store.transaction():
            state = self._state()
            now, regressed = self._time(state)
            usage = self.usage(state)
            reason = self.fault or ('clock-regression' if regressed else '') or ('90-day-limit' if state['started'] is not None and now - state['started'] >= DAYS else '') or ('256-MiB-limit' if usage['accounted_bytes'] >= LIMIT else '')
            if state['enabled'] and reason:
                self._pause(reason, now)
                state = self._state()
            elif state['enabled'] and now - state['clock'] >= 1:
                # Persist the observed high-water mark on the asynchronous status
                # cadence, not on each reader operation. Otherwise a restart can
                # forget a clock advance and silently extend the collection window.
                self.store.execute('UPDATE wr_evidence_control SET clock=? WHERE id=1', (now,))
                state['clock'] = now
            with self._queue_lock:
                self._consent = state['epoch'] if state['enabled'] and not self.fault else None
                queue_status = {'queued_events': len(self._queue), 'queued_bytes': self._queue_bytes}
            return {**state, **queue_status, **self.usage(state), "pause": state['pause'] or self.fault, "schema_version": SCHEMA, "limit_bytes": LIMIT,
                    "unacknowledged_tail": "unknown/gap: queued server operations are not durable; a process tail may be missing even without a session row",
                    "days": 90, "queue_reserve_bytes": QUEUE_RESERVE,
                    "events": self.store.query_one("SELECT COUNT(*) AS n FROM wr_evidence_event")["n"],
                    "contexts": self.store.query_one("SELECT COUNT(*) AS n FROM wr_evidence_context")["n"],
                    "unclosed_sessions": self.store.query_one("SELECT COUNT(*) AS n FROM wr_evidence_session WHERE closed=0")["n"]}

    def control(self, action, epoch):
        with self.store.transaction():
            state = self._state()
            if epoch != state["epoch"]:
                raise HTTPException(409, "设置已变更，请重新读取")
            if action == "clear":
                for table in ("event", "context", "session", "undo"):
                    self.store.execute(f"DELETE FROM wr_evidence_{table}")
                self.store.execute("UPDATE wr_evidence_control SET enabled=0,started=NULL,charged=0,pause='',epoch=?,clock=? WHERE id=1",
                                   (uuid.uuid4().hex, time.time()))
                self.fault = ""
                self._clock_seen = time.time()
            elif action == "disable":
                self.store.execute("UPDATE wr_evidence_control SET enabled=0,started=NULL,epoch=? WHERE id=1", (uuid.uuid4().hex,))
            elif action == "enable":
                if state["pause"] or self.usage(state)['accounted_bytes'] >= LIMIT:
                    raise HTTPException(409, "采集已到界或故障暂停；请先导出、清除阅读证据")
                if not state["enabled"]:
                    now = max(time.time(), state["clock"])
                    self.store.execute("UPDATE wr_evidence_control SET enabled=1,started=?,clock=?,epoch=? WHERE id=1",
                                       (now, now, uuid.uuid4().hex))
            else:
                raise HTTPException(422, "invalid action")
        if action in ('disable', 'clear'):
            with self._queue_lock:
                self._consent = None
                self._queue.clear()
                self._queue_bytes = 0
        if action == 'clear':
            # Explicit user cleanup only, never TTL. Business DB is never vacuumed.
            try:
                with self.store.lock:
                    checkpoint = self.store.con.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
                    if checkpoint[0]:
                        raise sqlite3.OperationalError('evidence export still holds a snapshot')
                    self.store.con.execute('VACUUM')
                    checkpoint = self.store.con.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
                    if checkpoint[0]:
                        raise sqlite3.OperationalError('evidence cleanup checkpoint busy')
            except sqlite3.Error:
                self.fault = 'capture-cleanup-incomplete'
                # Logical deletion and epoch rotation already committed. Persist
                # the remaining-space warning across restart; a later clear retries
                # compaction once an in-progress export releases its snapshot.
                self.store.execute("UPDATE wr_evidence_control SET pause=? WHERE id=1", (self.fault,))
        return self.status()

    def _append(self, epoch, events):
        """Caller owns transaction. Ack must only escape after its commit."""
        state = self._state()
        now, regressed = self._time(state)
        if not state["enabled"] or self.fault or epoch != state["epoch"]:
            raise HTTPException(409, "采集已关闭或epoch已失效")
        if regressed:
            return self._pause('clock-regression', now)
        if now - state["started"] >= DAYS:
            return self._pause("90-day-limit", now)
        pending, contexts, charge = [], {}, 0
        seen = {}
        for event in events:
            event = dict(event)
            snapshot = event.pop("snapshot", None)
            context_hash = None
            if snapshot is not None:
                raw = packed(snapshot)
                if len(raw.encode()) > 32768:
                    raise HTTPException(413, "单快照超过32KiB，客户端必须显式截断")
                context_hash = hashlib.sha256(raw.encode()).hexdigest()
                contexts[context_hash] = raw
            event["context_hash"] = context_hash
            raw = packed(event)
            if event['event_id'] in seen:
                if seen[event['event_id']] != raw:
                    raise HTTPException(409, "同一event_id内容冲突")
                continue
            seen[event['event_id']] = raw
            old = self.store.query_one("SELECT payload FROM wr_evidence_event WHERE event_id=?", (event["event_id"],))
            if old:
                if old["payload"] != raw:
                    raise HTTPException(409, "同一event_id内容冲突")
                continue
            pending.append((event, raw, context_hash))
            # Conservative upper bound for rows + both indexes (not logical JSON alone).
            charge += len(raw.encode()) * 4 + 4096
        for key, raw in contexts.items():
            if not self.store.query_one("SELECT hash FROM wr_evidence_context WHERE hash=?", (key,)):
                charge += len(raw.encode()) * 4 + 4096
        charge += len({e[0]["session_id"] for e in pending}) * 4096
        # Reserve for both DB and WAL growth, B-tree splits and operation links.
        # This intentionally pauses before the nominal physical cap can be reached.
        projected = max(state['charged'], self.usage(state)['disk_bytes']) + charge * 2 + len(pending) * 65536
        if projected + QUEUE_RESERVE >= LIMIT:
            return self._pause("256-MiB-limit", now)
        for key, raw in contexts.items():
            self.store.execute("INSERT OR IGNORE INTO wr_evidence_context VALUES(?,?)", (key, raw))
        for event, raw, context_hash in pending:
            self.store.execute("INSERT INTO wr_evidence_event(event_id,session_id,session_seq,operation_id,epoch,received,context_hash,payload) VALUES(?,?,?,?,?,?,?,?)",
                               (event["event_id"], event["session_id"], event["session_seq"], event.get("operation_id"), epoch, now, context_hash, raw))
            self.store.execute("INSERT INTO wr_evidence_session VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET last_seen=excluded.last_seen,closed=excluded.closed",
                               (event["session_id"], epoch, now, now, int(event["event_type"] == "session_closed")))
        self.store.execute("UPDATE wr_evidence_control SET charged=charged+?,clock=? WHERE id=1", (charge, now))
        return {"accepted": [e["event_id"] for e in events], "epoch": epoch, "durable": True}

    def _pause(self, reason, now):
        self.store.execute("UPDATE wr_evidence_control SET enabled=0,pause=?,epoch=?,clock=? WHERE id=1",
                           (reason, uuid.uuid4().hex, now))
        return {"accepted": [], "durable": False, "paused": reason}

    def append(self, epoch, events):
        try:
            with self.store.transaction():
                result = self._append(epoch, events)
        except sqlite3.IntegrityError:
            raise HTTPException(409, "采集身份/序列冲突，未接受此批次") from None
        except sqlite3.Error:
            self.fault = "capture-storage-failure"
            raise HTTPException(503, "采集存储失败，阅读业务不受采集重试影响") from None
        return result

    def _undo_before(self, token):
        rows = self.business_store.query("""SELECT 'collections' AS category,c.id,c.revision,c.deleted
            FROM wr_collection c JOIN wr_collection_undo_touch t ON t.record_id=c.id
            WHERE t.token=? AND t.category='collections'
            UNION ALL SELECT 'feedback',c.id,c.revision,c.deleted
            FROM wr_collection_feedback c JOIN wr_collection_undo_touch t ON t.record_id=c.id
            WHERE t.token=? AND t.category='feedback' LIMIT 65""", (token, token))
        return {(r['category'], r['id']): r for r in rows}

    def _resource_receipt(self, kind, result, details):
        """Whitelist the business undo journal while the business lock is held.

        No evidence-store IO, no user text retained, no inferred revision arithmetic.
        For undo, successful business validation has checked each after_revision
        against the actual row; read the restored revision before releasing the lock.
        """
        token = details.get('undo_token') if kind == 'undo' else result.get('undo_token')
        if not token:
            resource = result.get('state') or result.get('item')
            if not resource:
                return {'resources': [], 'resources_truncated': False}
            return {'resources': [{'category': 'feedback' if result.get('state') else 'collections',
                    'id': resource['id'], 'before_revision': resource['revision'],
                    'after_revision': resource['revision'], 'before_deleted': False, 'after_deleted': False}],
                    'resources_truncated': False}
        # Extract metadata in SQL: personal notes/meanings in journal.before.data
        # never become Python capture objects or queue entries.
        rows = self.business_store.query("""SELECT
            json_extract(j.value,'$.category') AS category,
            json_extract(j.value,'$.id') AS id,
            json_extract(j.value,'$.before.revision') AS before_revision,
            json_extract(j.value,'$.before.deleted') AS before_deleted,
            json_extract(j.value,'$.after_revision') AS committed_revision
            FROM wr_collection_undo u, json_each(u.changes) j
            WHERE u.token=? LIMIT 65""", (token,))
        resources = []
        for row in rows[:64]:
            table = {'collections': 'wr_collection', 'feedback': 'wr_collection_feedback'}.get(row['category'])
            if not table:
                raise ValueError('unknown resource category')
            current = self.business_store.query_one(f'SELECT revision,deleted FROM {table} WHERE id=?', (row['id'],))
            if not current:
                raise ValueError('missing committed resource')
            prior = details.get('_undo_before', {}).get((row['category'], row['id'])) if kind == 'undo' else None
            resources.append({'category': row['category'], 'id': row['id'],
                'before_revision': row['committed_revision'] if kind == 'undo' else row['before_revision'],
                'after_revision': current['revision'],
                'before_deleted': (bool(prior['deleted']) if prior else None) if kind == 'undo' else None if row['before_deleted'] is None else bool(row['before_deleted']),
                'after_deleted': bool(current['deleted'])})
        return {'resources': resources, 'resources_truncated': len(rows) > 64,
                'revision_basis': 'validated_business_undo_journal',
                'resources_gap': 'undo-before-state-unavailable' if kind == 'undo' and any(r['before_deleted'] is None for r in resources) else None}

    def business(self, request, kind, call, details=None):
        """Business COMMIT must succeed before optional capture is attempted."""
        captured = dict(details or {})
        try:
            with self.business_store.transaction():
                observing = request.headers.get('x-wr-evidence-epoch') == self._consent and self._consent and not self.fault
                if observing and kind == 'undo':
                    try:
                        captured['_undo_before'] = self._undo_before(captured.get('undo_token'))
                    except Exception:
                        captured['_undo_before'] = {}
                result = call()
                # Optional read-only metadata capture must not change business output.
                if observing:
                    try:
                        captured['_resource_receipt'] = self._resource_receipt(kind, result, captured)
                    except Exception:
                        captured['_resource_receipt'] = {'resources': [], 'resources_gap': 'metadata-unavailable'}
        except HTTPException as exc:
            self.capture_result(request, kind, 'conflict' if exc.status_code == 409 else 'failed',
                                {'http_status': exc.status_code}, details)
            raise
        self.capture_result(request, kind, 'succeeded', result, captured)
        return result

    def capture_result(self, request, kind, status, result, details):
        """Post-commit producer hook: no database IO and no durable ACK here."""
        try:
            epoch = request.headers.get('x-wr-evidence-epoch')
            with self._queue_lock:
                if not epoch or epoch != self._consent or self.fault or self._stop.is_set():
                    return
            op = identity(request.headers.get('x-wr-operation'))
            session = identity(request.headers.get('x-wr-session'))
            details = details or {}
            safe = {k: details[k] for k in ('doc_id', 'version', 'request_id', 'attempt_id', 'protocol',
                    'collection_id', 'expected_revision', 'assist_id', 'understood', 'retained', 'action') if k in details}
            token = details.get('undo_token')
            if token:
                safe['_undo_hash'] = hashlib.sha256(token.encode()).hexdigest()
            event = {'schema_version': SCHEMA, 'event_id': op + ':server', 'session_id': session,
                     'session_seq': 0, 'operation_id': op, 'event_type': kind, 'status': status,
                     'evidence_class': 'declaration' if kind == 'feedback_declaration' else 'fact',
                     'observer': 'server_post_commit', 'details': safe}
            anchor = details.get('anchor')
            if anchor:
                anchor = {k: anchor[k] for k in ('version', 'block_id', 'start', 'end', 'quote', 'prefix', 'suffix', 'segments', 'pdf') if k in anchor}
                snapshot = {'kind': 'operation_source', 'doc_id': safe.get('doc_id'), 'anchor': anchor, 'truncated': False}
                if len(packed(snapshot).encode()) > 32768:
                    snapshot = {'kind': 'operation_source', 'doc_id': safe.get('doc_id'), 'version': anchor.get('version'), 'truncated': True}
                event['snapshot'] = snapshot
            undo_hash = None
            if isinstance(result, dict):
                resource = result.get('state') or result.get('item') or result
                event['result'] = {k: resource[k] for k in ('id', 'revision', 'http_status', 'changed') if k in resource}
                if status == 'succeeded' and '_resource_receipt' in details:
                    event['result'].update(details['_resource_receipt'])
                if result.get('undo_token'):
                    undo_hash = hashlib.sha256(result['undo_token'].encode()).hexdigest()
            raw = packed(event).encode()  # immutable; never retain the caller's objects
            with self._queue_lock:
                if epoch != self._consent or self.fault:
                    return
                if len(self._queue) >= 128 or self._queue_bytes + len(raw) > 512 * 1024:
                    self.fault = 'capture-queue-full'
                    self._consent = None
                    return
                self._queue.append((epoch, raw, undo_hash))
                self._queue_bytes += len(raw)
                if len(self._queue) >= 32:
                    self._wake.set()
        except Exception:
            self.fault = 'capture-producer-failure'

    def events(self, after=0, limit=100):
        rows = self.store.query("SELECT ordinal,epoch,received,payload FROM wr_evidence_event WHERE ordinal>? ORDER BY ordinal LIMIT ?", (after, limit))
        return [{**json.loads(r["payload"]), "ordinal": r["ordinal"], "collection_epoch": r["epoch"], "received_time": r["received"]} for r in rows]

    def context(self, key):
        row = self.store.query_one("SELECT payload FROM wr_evidence_context WHERE hash=?", (key,))
        if not row:
            raise HTTPException(404, "context")
        return json.loads(row["payload"])
