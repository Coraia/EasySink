"""M2/M3 API：密度只走 L2；反馈落库；考纲自评。"""

from pathlib import Path

from fastapi.testclient import TestClient

from wise_reader.app import create_app
from wise_reader.settings import Settings


def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setenv("WR_USER_DB", str(tmp_path / "user.db"))
    monkeypatch.setenv("WR_LLM_ENABLED", "false")
    # Settings reads env at init
    return TestClient(create_app())


def test_create_and_density_query(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    text = Path("tests/fixtures/b_opinion.txt").read_text(encoding="utf-8")
    created = c.post("/api/documents", json={"title": "gerrymander", "text": text}).json()
    assert created["id"]
    assert created["fragment_count"] < 200
    assert created["density_actual"] <= 4.5
    low = c.get(f"/api/documents/{created['id']}", params={"density": 1}).json()
    high = c.get(f"/api/documents/{created['id']}", params={"density": 8}).json()
    assert low["annotation_count"] <= high["annotation_count"]
    # 分片数随标注变，但仍按标注切分
    assert low["fragment_count"] <= high["fragment_count"]
    assert all(f["type"] in ("plain", "anno") for f in created["fragments"])


def test_feedback_known_disappears_on_refetch(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    text = "The ubiquitous serendipity of photosynthesis is rare."
    created = c.post("/api/documents", json={"text": text, "title": "t"}).json()
    annos = [f for f in created["fragments"] if f["type"] == "anno"]
    assert annos
    lemma = annos[0]["lemma"]
    c.post("/api/feedback", json={"lemma": lemma, "verdict": "known"})
    again = c.get(f"/api/documents/{created['id']}").json()
    left = [f["lemma"] for f in again["fragments"] if f["type"] == "anno"]
    assert lemma not in left


def test_lookup_marks_unknown(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    r = c.post("/api/lookup", json={"word": "serendipity", "mark_unknown": True}).json()
    assert r["found"]
    p = c.get("/api/profile").json()
    assert p["unknown_count"] >= 1


def test_pages_and_profile_api(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    home = c.get("/")
    assert home.status_code == 200
    assert 'href="#/profile"' in home.text
    js = c.get("/static/app.js")
    assert js.status_code == 200
    assert "renderProfile" in js.text
    p = c.get("/api/profile").json()
    assert "exam_vocab" in p
    assert p["exam_vocab"]["ielts"] == 8000

    c = client(tmp_path, monkeypatch)
    p = c.patch("/api/profile", json={"exam": "cet6"}).json()
    assert p["vocab_size"] == 6000
    text = "Hello ubiquitous world of serendipity and photosynthesis."
    doc = c.post("/api/documents", json={"text": text, "title": "x"}).json()
    c.post(
        f"/api/documents/{doc['id']}/finish",
        json={"annotation_count": doc["annotation_count"], "manual_lookups": 1, "felt_density": "合适"},
    )
    logs = c.get("/api/reading-log").json()
    assert logs[0]["manual_lookups"] == 1
    assert logs[0]["felt_density"] == "合适"


def test_vocab_test_converges(tmp_path, monkeypatch):
    c = client(tmp_path, monkeypatch)
    q = c.post("/api/vocab-test/start", json={}).json()
    steps = 0
    while not q["finished"]:
        steps += 1
        assert steps <= 25
        word = q["question"]["word"]
        q = c.post(
            "/api/vocab-test/answer",
            json={"session": q["session"], "word": word, "known": steps < 8},
        ).json()
    assert q["estimate"]
    p = c.get("/api/profile").json()
    assert p["vocab_size"] == q["estimate"]
    assert p["known_count"] >= 1
