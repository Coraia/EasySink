"""Run the disposable review tool: .venv/bin/python scripts/prototypes/pdf_body_projection/review.py"""

import argparse
import json
import os
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from contextlib import closing
from functools import lru_cache
from pathlib import Path
from types import SimpleNamespace
from typing import Literal

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.testclient import TestClient
from pydantic import BaseModel

from wise_reader import page_translation
from wise_reader.app import create_app
from wise_reader.pdf_lab.worker import worker_python
from wise_reader.settings import Settings

from fixtures import CASES, make_pdf
from projection import Projection

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def checked(response):
    response.raise_for_status()
    return response.json()


def render_original(path, number_set, out):
    code = """
import sys
from pathlib import Path
from pypdfium2 import PdfDocument
pdf = PdfDocument(sys.argv[1])
for value in sys.argv[3:]:
    page = pdf[int(value) - 1]
    image = page.render(scale=1.35)
    image.to_pil().save(Path(sys.argv[2]) / (value + '.png'))
    image.close()
    page.close()
pdf.close()
"""
    subprocess.run([str(worker_python()), "-c", code, str(path), str(out), *map(str, number_set)], check=True)


def intersector(unit, numbers):
    return any(s is not None and s.block.page in numbers for s in unit.mapping)


def provider_payload(units):
    return {"task": "page-translation", "paragraphs": [
        {"id": i, "source": unit.text} for i, unit in enumerate(units)]}


def mock_translate(paragraphs):
    translations = []
    for entry in paragraphs:
        source = entry["source"]
        if "researchers examined" in source and "for a second round" in source:
            zh = "研究人员仔细检查了全部样本并做好记录，然后把剩余材料送往实验室进行第二轮检测。报告于次周送达。"
        elif "prepared" in source and "tight-gap" not in source:
            zh = "为下一轮试验做准备，研究人员备好了仪器。"
        else:
            zh = f"模拟译文 · 第 {entry['id'] + 1} 段"
        translations.append({"id": entry["id"], "segments": [{"quote": source, "zh": zh}]})
    return translations


def import_case(client, name, directory, lookup, capture):
    title, count, focus = CASES[name]
    out = directory / name
    out.mkdir()
    path = out / (name + ".pdf")
    make_pdf(path, name)
    response = client.post("/api/pdf/imports", data={"engine": "auto"},
                           files={"file": (path.name, path.read_bytes(), "application/pdf")})
    book_id = checked(response)["book_id"]
    deadline = time.monotonic() + 20
    while True:
        book = checked(client.get(f"/api/pdf/books/{book_id}"))
        if book["pdf"]["ready_pages"] == count and book["task"]["state"] == "completed":
            break
        if time.monotonic() > deadline or book["task"]["state"] in {"failed", "paused", "cancelled"}:
            raise RuntimeError(f"{name}: 导入未完成：{book['task']}")
        time.sleep(.04)

    shown = tuple(n for n in (focus, focus + 1) if n <= count)
    documents, before, refs = {}, [], []
    for scope in book["pdf"]["ranges"]:
        doc = checked(client.get(f"/api/documents/{scope['doc_id']}"))
        for number in range(scope["start_page"], scope["end_page"] + 1):
            documents[number] = (doc["id"], doc["version"])
        for block in doc["blocks"]:
            number = block["source"]["page_number"]
            if number not in shown:
                continue
            before.append({"page": number, "source": block["text"]})
            if page_translation.translatable(block):
                ref = block.get("paragraph_group", {}).get("blocks", [block["id"]])[0]
                refs.append({"doc_id": doc["id"], "version": doc["version"], "block_id": ref})
    checked(client.post(f"/api/documents/{refs[0]['doc_id']}/page-translation",
                        json={"blocks": refs, "generate": True}))
    model = client.app.state.pdf
    _, source = model.source_book(book_id)
    retained = model.workers.result(source, 1, count, {book["task"]["id"]})["pages"]
    pages = {page["page_number"]: page for page in retained}
    render_original(path, shown, out)
    return SimpleNamespace(id=name, title=title, shown=shown, directory=out, before=before,
                           payload=capture[-1], projection=Projection(pages, documents, lookup))


def load_cases(directory, dictionary):
    @lru_cache(maxsize=512)
    def lookup(word):
        return dictionary.execute("SELECT 1 FROM stardict WHERE word=? LIMIT 1", (word,)).fetchone() is not None

    os.environ["WR_PDF_DATA_DIR"] = str(directory / "pdf-store")
    os.environ["WR_NATIVE_TRACKPAD"] = "0"
    capture = []

    async def provider(app, request, prompt, payload, config, **kwargs):
        capture.append(payload)
        return {"paragraphs": mock_translate(payload["paragraphs"])}

    production_provider = page_translation.model_json
    page_translation.model_json = provider
    try:
        settings = Settings(_env_file=None, wr_user_db=str(directory / "user.db"),
                            wr_llm_enabled=False, wr_llm_api_key="")
        with TestClient(create_app(settings)) as client:
            checked(client.put("/api/ai/config", json={"text": {"enabled": True,
                "base_url": "http://127.0.0.1:1/v1", "api_key": "fixture", "model": "fixture"}}))
            return {name: import_case(client, name, directory, lookup, capture) for name in CASES}
    finally:
        page_translation.model_json = production_provider


def snapshot(case):
    lens = case.projection
    shown = set(case.shown)
    units = [u for u in lens.paragraphs() if intersector(u, shown)]
    waiting = lens.waiting_unit()
    sending = [u for u in units if not waiting or u.mapping[-1] != waiting.mapping[-1]]
    after = provider_payload(sending)
    translations = mock_translate(after["paragraphs"])
    return {"id": case.id, "title": case.title, "shown": case.shown, "before": case.before,
            "beforePayload": case.payload, "afterPayload": after, "changed": lens.changed,
            "waiting": bool(waiting), "hidden": lens.hidden,
            "after": [dict(source=u.text, notes=u.notes,
                           waiting=bool(waiting and u.mapping[-1] == waiting.mapping[-1]),
                           repairs=list(u.repaired_words())) for u in units],
            "translations": [{"text": t["segments"][0]["zh"], "ranges": u.ranges(), "notes": u.notes}
                             for u, t in zip(sending, translations)],
            "pages": [{"number": n, "width": lens.pages[n]["width"], "height": lens.pages[n]["height"],
                       "method": lens.pages[n]["extraction_method"],
                       "objects": [{"id": b.id, "source": b.text, "box": b.box,
                                    "role": lens.role(b)[0], "evidence": lens.role(b)[1],
                                    "override": b.id in lens.overrides} for b in lens.blocks[n]]}
                      for n in case.shown if n != lens.hidden]}


class Edit(BaseModel):
    action: Literal["body", "exclude", "reset", "pending"]
    id: str | None = None


def review_app(cases):
    app = FastAPI(docs_url=None, redoc_url=None)

    @app.get("/")
    async def page():
        return FileResponse(HERE / "review.html")

    @app.get("/assets/{name}")
    async def assets(name: Literal["review.js", "review.css"]):
        return FileResponse(HERE / name)

    @app.get("/api/cases")
    async def list_cases():
        return [{"id": case.id, "title": case.title} for case in cases.values()]

    @app.get("/api/cases/{name}")
    async def state(name: str):
        if name not in cases:
            raise HTTPException(404)
        return snapshot(cases[name])

    @app.post("/api/cases/{name}")
    async def edit(name: str, data: Edit):
        if name not in cases:
            raise HTTPException(404)
        case = cases[name]
        if data.action == "pending" and len(case.shown) == 2:
            case.projection.pending(case.shown[1])
        elif data.action != "pending" and data.id in case.projection.by_id:
            case.projection.override(data.id, data.action)
        else:
            raise HTTPException(422, "无法应用此更改")
        return snapshot(case)

    @app.get("/original/{name}/{number}")
    async def original(name: str, number: int):
        if name not in cases or number not in cases[name].shown:
            raise HTTPException(404)
        return FileResponse(cases[name].directory / f"{number}.png")

    return app


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8767)
    parser.add_argument("--verify", action="store_true", help="exercise real import and print review data")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with tempfile.TemporaryDirectory(prefix="easysink-pdf-review-") as isolated, closing(
        sqlite3.connect((ROOT / "data/stardict.db").as_uri() + "?mode=ro&immutable=1", uri=True)
    ) as dictionary:
        cases = load_cases(Path(isolated), dictionary)
        if args.verify:
            print(json.dumps({name: snapshot(case) for name, case in cases.items()}, ensure_ascii=False))
        else:
            uvicorn.run(review_app(cases), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
