"""Migration compatibility for owned reading state and restored PDF originals."""

import hashlib
import json

from wise_reader.pdf_lab.storage import LabStore


def registered(store, tmp_path, content=b"registered-pdf", pages=3):
    incoming = tmp_path / "incoming.pdf"
    incoming.write_bytes(content)
    digest = hashlib.sha256(content).hexdigest()
    book, task, _ = store.register(incoming, "fixture", digest, len(content), pages, 1.0)
    return book, task, content


def test_registry_recovers_verified_original_and_preserves_previous_state(tmp_path):
    store = LabStore(tmp_path / "pdf")
    book, task, content = registered(store, tmp_path)
    store.update(task["id"], state="completed", done_pages=3,
                 metrics={"conversion_metrics": {"range_complete": True}})
    source = store.source(book)
    source.unlink()

    store.recover_registry()
    failed = store.task(task["id"])
    assert failed["state"] == "failed"
    assert failed["error"]["code"] == "source_missing"
    assert failed["error"]["previous_state"] == "completed"

    source.write_bytes(content)
    store.recover_registry()
    recovered = store.task(task["id"])
    assert recovered["state"] == "completed"
    assert recovered["error"] is None
    report = json.loads((store.root / "recovery.json").read_text())
    assert report["restored_books"] == [book["id"]]
    assert report["missing_books"] == []


def test_registry_never_recovers_wrong_content_with_registered_name(tmp_path):
    store = LabStore(tmp_path / "pdf")
    book, task, content = registered(store, tmp_path)
    store.update(task["id"], state="completed", done_pages=3,
                 metrics={"conversion_metrics": {"range_complete": True}})
    source = store.source(book)
    source.write_bytes(b"x" * len(content))

    store.recover_registry()
    failed = store.task(task["id"])
    assert failed["state"] == "failed"
    assert failed["error"]["code"] == "source_missing"
    report = json.loads((store.root / "recovery.json").read_text())
    assert report["invalid_originals"] == [book["id"]]
    assert report["restored_books"] == []


def test_registry_recovers_legacy_source_missing_when_completion_is_proven(tmp_path):
    store = LabStore(tmp_path / "pdf")
    book, task, _ = registered(store, tmp_path)
    store.update(task["id"], state="failed", done_pages=3,
                 metrics={"conversion_metrics": {"full_document_complete": True}},
                 error={"code": "source_missing", "message": "legacy"})

    store.recover_registry()
    recovered = store.task(task["id"])
    assert recovered["state"] == "completed"
    assert recovered["error"] is None
