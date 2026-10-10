"""R1–R3 production-route replay, synthetic data in fresh temporary databases.

Failure classes precede this helper in v11-records-integration-review.md.
Run with PYTHONPATH=src .venv/bin/python -m wise_reader.collections_repair_smoke.
No provider, user configuration, running service, browser or unit-test doubles.
Every request/response is retained losslessly; large bodies use gzip artifacts.
"""
from __future__ import annotations

import copy
import gzip
import hashlib
import json
import tempfile
import traceback
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from wise_reader import content
from wise_reader.collections import migrate
from wise_reader.collections_source import packed
from wise_reader.plugins import collections as plugin
from wise_reader.reading_assist import migrate as assist_migrate
from wise_reader.store import Store

LIMIT = 8 * 1024 * 1024
TEXT = "abcdefghij klmnopqrst uvwxyz0123 456789ABCD EFGHIJKLMN OPQRSTUVWX YZabcdefgh ijklmnopqr stuvwxyz01 23456789AB"


def run():
    root = Path(tempfile.mkdtemp(prefix="wise-collections-repair-"))
    print("Evidence: " + str(root), flush=True)
    checks, stores, clients = [], [], []
    sequence = 0

    def log(value):
        with (root / "transcript.jsonl").open("a") as out:
            out.write(json.dumps(value, ensure_ascii=False) + "\n")

    def artifact(raw, label):
        path = root / (label + ".gz")
        path.write_bytes(gzip.compress(raw, mtime=0))
        return {"file": path.name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}

    def check(name, passed, **detail):
        value = {"check": name, "passed": bool(passed), **detail}
        checks.append(value)
        log(value)
        print(("PASS " if passed else "FAIL ") + name, flush=True)

    def request(client, method, path, body=None, expected=200):
        nonlocal sequence
        sequence += 1
        raw = packed(body).encode() if body is not None else b""
        response = client.request(method, "/api/collections" + path, content=raw,
                                  headers={"Content-Type": "application/json"})
        entry = {"request_number": sequence, "method": method, "path": path,
                 "status": response.status_code,
                 "request": artifact(raw, f"{sequence:03}-request"),
                 "response": artifact(response.content, f"{sequence:03}-response")}
        log(entry)
        if expected is not None and response.status_code != expected:
            raise AssertionError({**entry, "detail": response.text[:500]})
        return response

    def setup(name, source=True):
        store = Store(root / (name + ".db"))
        stores.append(store)
        migrate(store)
        assist_migrate(store)
        app = FastAPI()
        app.state.store = store
        plugin.register(app, SimpleNamespace(store=store))
        client = TestClient(app)
        clients.append(client)
        if source:
            doc_id = store.save_document("Repair source", TEXT, 10, hashlib.sha256(TEXT.encode()).hexdigest(), [], [])
            version, blocks = content.put_content(store, doc_id, TEXT)
            return store, client, doc_id, version, blocks
        return store, client, None, None, None

    def save(lib, start, end, meaning="", explanations=False):
        store, client, doc_id, version, blocks = lib
        anchor = {"version": version, "block_id": blocks[0]["id"], "start": start, "end": end, "quote": TEXT[start:end]}
        result = request(client, "POST", "", {"doc_id": doc_id, "kind": "excerpt", "anchor": anchor}).json()["item"]
        if meaning:
            result = request(client, "PATCH", f"/{result['id']}", {"my_meaning": meaning, "expected_revision": result["revision"]}).json()["item"]
        if explanations:
            for n in (1, 2):
                # Persisted synthetic successful results, never a provider call.
                aid = store.execute("INSERT INTO wr_assist(doc_id,version,kind,identity,anchor,payload,source,created_at) VALUES(?,?,?,?,?,?,?,?)",
                    (doc_id, version, "context", f"{meaning}-{n}", packed(result["anchor"]),
                     packed({"meaning": f"{meaning}-explanation-{n}", "explanation": "Synthetic stored result"}), "repair fixture", "2026-10-11")).lastrowid
                result = request(client, "PATCH", f"/{result['id']}", {"adopt_assist_id": aid, "expected_revision": result["revision"]}).json()["item"]
        return result

    def export(lib):
        return request(lib[1], "POST", "/export", {"collections": True, "format": "json"})

    def restore(lib, data, expected=200):
        return request(lib[1], "POST", "/import", {"data": data}, expected)

    def current(lib):
        return request(lib[1], "GET", "").json()["items"]

    def has_personal(record, meaning):
        return any(s.get("my_meaning") == meaning and s.get("explanation", {}).get("text", "").startswith(meaning)
                   and len(s.get("explanation_history", [])) == 1
                   for s in record.get("subranges", []) if s.get("explanation"))

    files = [Path(__file__), Path(plugin.__file__), Path(__file__).with_name("collections_transfer.py"), Path(__file__).with_name("collections.py")]
    log({"production_files": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
         "scope": "synthetic source and persisted assist fixtures; production FastAPI routes and Store; temporary DBs only"})
    try:
        a, b = setup("r1-local"), setup("r1-foreign")
        save(a, 0, 5, "R1 local meaning", explanations=True)
        save(b, 0, 10)
        foreign = export(b).json()
        restore(a, foreign)
        merged = current(a)[0]
        check("R1 expanded import preserves local meaning/explanation/history", merged["quote"] == TEXT[:10] and has_personal(merged, "R1 local meaning"))
        check("R1 re-export retains local subrange", has_personal(export(a).json()["collections"][0], "R1 local meaning"))
        before = copy.deepcopy(merged)
        restore(a, foreign)
        check("R1 repeated restore leaves content and revision stable", current(a)[0] == before)

        a, b, c = setup("r2-local"), setup("r2-foreign-one"), setup("r2-foreign-two")
        save(a, 0, 10)
        save(b, 0, 5, "R2 foreign one", explanations=True)
        save(b, 0, 10)
        save(c, 1, 4, "R2 foreign two", explanations=True)
        save(c, 0, 10)
        for label, lib in (("one", b), ("two", c)):
            payload = export(lib).json()
            restore(a, payload)
            restored = current(a)[0]
            check("R2 distinct UID adds nested personal content " + label, has_personal(restored, "R2 foreign " + label))
            before = copy.deepcopy(restored)
            restore(a, payload)
            check("R2 same UID replay is stable " + label, current(a)[0] == before)
        record = current(a)[0]
        check("R2 both nested histories survive re-export", all(has_personal(export(a).json()["collections"][0], "R2 foreign " + label) for label in ("one", "two")))
        check("R2 nested records are deduplicated", len({packed(s) for s in record["subranges"]}) == len(record["subranges"]))
        record = request(a[1], "PATCH", f"/{record['id']}", {"my_meaning": "new local edit", "expected_revision": record["revision"]}).json()["item"]
        restore(a, export(b).json())
        check("R2 old backup never overwrites newer local meaning", current(a)[0]["my_meaning"] == "new local edit")

        # Fresh-ID same-range import with distinct whole and nested material.
        changed = copy.deepcopy(export(b).json())
        changed["collections"][0]["uid"] += "-new-root"
        changed["collections"][0]["my_meaning"] = "foreign whole meaning"
        restore(a, changed)
        record = current(a)[0]
        check("R2 different root meaning remains a subrange", record["my_meaning"] == "new local edit" and any(s.get("my_meaning") == "foreign whole meaning" for s in record["subranges"]))
        bad = copy.deepcopy(changed)
        bad["collections"][0]["uid"] += "-invalid"
        bad["collections"][0]["subranges"][0]["quote"] = "forged"
        before = current(a)
        restore(a, bad, 422)
        check("invalid nested import is atomic", current(a) == before)

        # Boundary material is an actual API export with synthetic imported
        # explanation histories. Missing sources deliberately stay unresolved.
        seed, bulk, target = setup("boundary-seed"), setup("boundary-export", False), setup("boundary-restore", False)
        for i in range(10):
            save(seed, i * 11, i * 11 + 10)
        data = export(seed).json()
        for i, entry in enumerate(data["collections"]):
            entry["uid"] = f"boundary-{i}"
            entry["explanation_history"] = [{"text": f"{n:02}" + "x" * 10398, "source": "synthetic history", "kind": "context"} for n in range(80)]
            one = {**data, "collections": [entry]}
            restore(bulk, one)
        data = export(bulk).json()
        gap = LIMIT - len(packed(data).encode())
        if not 0 <= gap <= 200000:
            raise AssertionError({"boundary_fixture_gap": gap})
        for entry in data["collections"]:
            size = min(gap, 20000)
            if size:
                request(bulk[1], "PATCH", f"/{entry['id']}", {"my_meaning": "p" * size, "expected_revision": entry["revision"]})
                gap -= size
        boundary = export(bulk)
        data = boundary.json()
        compact_bytes = len(packed(data).encode())
        check("R3 fixture reaches exact legal data boundary", compact_bytes == LIMIT, compact_bytes=compact_bytes)
        check("R3 downloadable JSON fits frontend 8 MiB limit", len(boundary.content) <= LIMIT, file_bytes=len(boundary.content), limit=LIMIT)
        restored = restore(target, data, expected=None)
        check("R3 exact-boundary export restores through wrapped API", restored.status_code == 200, status=restored.status_code, request_bytes=len(packed({"data": data}).encode()), response=restored.json())
        check("R3 restored record count", len(current(target)) == 10)
        if restored.status_code == 200:
            before = current(target)
            again = restore(target, data)
            check("R3 boundary replay is idempotent", again.json()["duplicates"] == 10 and current(target) == before)
        over = copy.deepcopy(data)
        over["collections"][0]["my_meaning"] += "x"
        before = current(target)
        restore(target, over, 413)
        check("R3 one-byte oversized import rejects atomically", current(target) == before)
        entry = current(bulk)[-1]
        request(bulk[1], "PATCH", f"/{entry['id']}", {"my_meaning": entry["my_meaning"] + "x", "expected_revision": entry["revision"]})
        response = request(bulk[1], "POST", "/export", {"format": "json"}, expected=413)
        check("R3 oversized export fails before producing a backup", response.status_code == 413)
    except Exception:
        log({"unexpected_failure": traceback.format_exc()})
        traceback.print_exc()
        checks.append({"check": "scenario completes without unexpected failure", "passed": False})
    finally:
        for client in clients:
            client.close()
        for store in stores:
            store.close()
        result = {"checks": checks, "passed": sum(c["passed"] for c in checks), "failed": sum(not c["passed"] for c in checks), "requests": sequence, "evidence": str(root)}
        (root / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        print(json.dumps({k: v for k, v in result.items() if k != "checks"}), flush=True)
    return result["failed"] == 0


if __name__ == "__main__":
    raise SystemExit(0 if run() else 1)
