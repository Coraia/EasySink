from __future__ import annotations

import hashlib
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from wise_reader.ai import AIConfig, register_ai
from wise_reader.engine import Engine
from wise_reader.jobs import Jobs
from wise_reader.l1 import NullLLM, OpenAICompatLLM
from wise_reader.lexicon import Lexicon
from wise_reader.native_input import register as register_native_input
from wise_reader.plugins import PluginContext, mount_plugins
from wise_reader.profile import DOMAINS, EXAM_VOCAB
from wise_reader.reading_assist import close_assistance, register as register_reading_assist
from wise_reader.settings import ROOT, Settings
from wise_reader.store import Store, _now
from wise_reader.vocab_test import VocabTester, question_payload

WEB = ROOT / "web"


class DocumentIn(BaseModel):
    text: str = Field(min_length=1, max_length=500000)
    title: str = ""


class FeedbackIn(BaseModel):
    lemma: str = ""
    target: str = ""
    verdict: Literal["known", "unknown", "reset"]


class ProfilePatch(BaseModel):
    vocab_size: int | None = Field(default=None, ge=500, le=50000)
    density: float | None = Field(default=None, ge=0, le=15)
    domains: list[str] | None = None
    repeat: bool | None = None
    l1_enabled: bool | None = None
    exam: str | None = None


class LookupIn(BaseModel):
    word: str
    mark_unknown: bool = True


class VocabAnswerIn(BaseModel):
    session: str
    word: str
    known: bool


class FinishIn(BaseModel):
    annotation_count: int
    manual_lookups: int = 0
    felt_density: str | None = None


def create_app(settings: Settings | None = None) -> FastAPI:
    assets = hashlib.sha256()
    for path in sorted(WEB.rglob("*")):
        if path.is_file() and path.suffix in (".js", ".css", ".html"):
            assets.update(str(path.relative_to(WEB)).encode())
            assets.update(path.read_bytes())
    asset_prefix = "/assets/" + assets.hexdigest()[:16]
    settings = settings or Settings()
    lexicon = Lexicon()
    store = Store(Path(settings.wr_user_db) if settings.wr_user_db else None)
    llm = NullLLM()
    l1_on = False
    if settings.wr_llm_enabled and settings.wr_llm_api_key:
        llm = OpenAICompatLLM(
            settings.wr_llm_base_url,
            settings.wr_llm_api_key,
            settings.wr_llm_model,
        )
        l1_on = True
    engine = Engine(lexicon, store, llm=llm, l1_enabled=l1_on)
    ai = AIConfig(settings, engine, store)
    tester = VocabTester(lexicon)
    jobs = Jobs(store, engine)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        jobs.start()
        pdf = getattr(_app.state, "pdf", None)
        if pdf is not None:
            await pdf.start()
        yield
        if pdf is not None:
            await pdf.close()
        await close_assistance(_app)
        jobs.close()
        lexicon.close()
        store.close()

    app = FastAPI(title="Wise Reader", lifespan=lifespan)
    app.state.engine = engine
    app.state.store = store
    app.state.tester = tester
    app.state.jobs = jobs
    app.state.ai = ai
    register_native_input(app, ROOT)
    register_ai(app, ai)

    @app.get("/health")
    def health():
        return {"ok": True, "version": "0.2.0", "web_revision": "20261008-pdf-reader"}

    @app.get("/api/jobs")
    def job_list():
        return [
            jobs.payload(r)
            for r in store.query("SELECT * FROM wr_job ORDER BY id DESC LIMIT 30")
        ]

    @app.post("/api/jobs/{job_id}/{action}")
    def job_action(job_id: int, action: Literal["retry", "cancel"]):
        return jobs.control(job_id, action)

    @app.post("/api/documents/{doc_id}/analyze")
    def analyze_document(doc_id: int):
        pdf = getattr(app.state, "pdf", None)
        if pdf is not None and pdf.document_metadata(doc_id) is not None:
            raise HTTPException(422, "PDF 请选定句段使用语境解释、翻译或语法分析。")
        return jobs.enqueue([doc_id], "annotations")

    @app.post("/api/documents/{doc_id}/archive")
    def archive_document(doc_id: int):
        if not store.get_document(doc_id):
            raise HTTPException(404, "not found")
        store.execute("INSERT OR REPLACE INTO wr_archive VALUES(?,?)", (doc_id, _now()))
        return {"ok": True}

    @app.post("/api/documents/{doc_id}/restore")
    def restore_document(doc_id: int):
        store.execute("DELETE FROM wr_archive WHERE doc_id=?", (doc_id,))
        return {"ok": True}

    @app.get("/api/profile")
    def get_profile():
        p = store.get_profile()
        return {
            "vocab_size": p.vocab_size,
            "density": p.density,
            "domains": sorted(p.domains),
            "repeat": p.repeat,
            "l1_enabled": p.l1_enabled,
            "known_count": len(p.known),
            "unknown_count": len(p.unknown),
            "verdict_count": len(p.known) + len(p.unknown),
            "domain_catalog": DOMAINS,
            "exam_vocab": EXAM_VOCAB,
            "l1_available": engine.l1_enabled,
        }

    @app.patch("/api/profile")
    def patch_profile(body: ProfilePatch):
        fields = {}
        if body.exam:
            if body.exam not in EXAM_VOCAB:
                raise HTTPException(400, "unknown exam")
            fields["vocab_size"] = EXAM_VOCAB[body.exam]
        if body.vocab_size is not None:
            fields["vocab_size"] = body.vocab_size
        if body.density is not None:
            fields["density"] = body.density
        if body.domains is not None:
            fields["domains"] = [d for d in body.domains if d in DOMAINS]
        if body.repeat is not None:
            fields["repeat"] = body.repeat
        if body.l1_enabled is not None:
            fields["l1_enabled"] = body.l1_enabled
        store.update_profile(**fields)
        return get_profile()

    @app.post("/api/documents")
    def create_document(body: DocumentIn):
        if not body.text.strip():
            raise HTTPException(400, "请输入英文原文")
        profile = store.get_profile()
        doc = engine.ingest(body.title, body.text, profile, analyze=False)
        return doc

    @app.get("/api/documents")
    def list_documents():
        archived = {r["doc_id"] for r in store.query("SELECT doc_id FROM wr_archive")}
        return [{**r, "archived": r["id"] in archived} for r in store.list_documents()]

    @app.get("/api/documents/{doc_id}")
    def get_document(
        doc_id: int,
        density: float | None = Query(default=None, ge=0, le=15),
        compact: bool = False,
    ):
        profile = store.get_profile()
        try:
            result = engine.present(doc_id, profile, density=density, compact=compact)
            pdf = getattr(app.state, "pdf", None)
            if pdf is not None:
                metadata = pdf.document_metadata(doc_id)
                if metadata is not None:
                    result["pdf"] = metadata
            return result
        except KeyError:
            raise HTTPException(404, "not found")

    @app.delete("/api/documents/{doc_id}")
    def delete_document(doc_id: int):
        pdf = getattr(app.state, "pdf", None)
        if pdf is not None and pdf.document_metadata(doc_id) is not None:
            raise HTTPException(409, "PDF 阅读范围属于原书，请从书架回收整本书；原件与记录会保留。")
        store.delete_document(doc_id)
        return {"ok": True}

    @app.post("/api/documents/{doc_id}/finish")
    def finish_document(doc_id: int, body: FinishIn):
        if store.get_document(doc_id) is None:
            raise HTTPException(404, "not found")
        store.add_reading_log(
            doc_id, body.annotation_count, body.manual_lookups, body.felt_density
        )
        return {"ok": True}

    @app.post("/api/feedback")
    def feedback(body: FeedbackIn):
        target = (body.target or body.lemma).strip().lower()
        if not target or len(target) > 500:
            raise HTTPException(400, "无效的标注目标")
        with store.transaction():
            previous = (
                store.query_one(
                    "SELECT verdict FROM wr_target WHERE target=?", (target,)
                )
                if ":" in target
                else store.query_one(
                    "SELECT verdict FROM word_verdict WHERE lemma=?", (target,)
                )
            )
            if ":" in target:
                if body.verdict == "reset":
                    store.execute("DELETE FROM wr_target WHERE target=?", (target,))
                else:
                    store.execute(
                        "INSERT OR REPLACE INTO wr_target VALUES(?,?,?)",
                        (target, body.verdict, _now()),
                    )
            elif body.verdict == "reset":
                store.execute("DELETE FROM word_verdict WHERE lemma=?", (target,))
            else:
                store.set_verdict(target, body.verdict, "feedback")
        return {"ok": True, "previous": previous["verdict"] if previous else "reset"}

    @app.post("/api/lookup")
    def lookup(body: LookupIn):
        result = engine.lookup(body.word)
        if body.mark_unknown and result["found"]:
            store.set_verdict(result["lemma"], "unknown", "feedback")
        return result

    @app.get("/api/reading-log")
    def reading_log():
        return store.list_reading_logs()

    @app.post("/api/vocab-test/start")
    def vocab_start():
        session = tester.start()
        return question_payload(session)

    @app.post("/api/vocab-test/answer")
    def vocab_answer(body: VocabAnswerIn):
        try:
            session = tester.answer(body.session, body.word, body.known)
        except KeyError:
            raise HTTPException(404, "测试已过期，请重新开始")
        except ValueError as e:
            raise HTTPException(409, str(e))
        if session.finished and session.estimate:
            store.update_profile(vocab_size=session.estimate)
            for w in session.known_words:
                store.set_verdict(w, "known", "vocab_test")
        return question_payload(session)

    ctx = PluginContext(
        store=store,
        engine=engine,
        llm=engine.llm,
        l1_on=engine.l1_enabled,
        settings=settings,
    )
    ai.ctx = ctx
    register_reading_assist(app, ctx)
    mount_plugins(app, ctx)

    @app.get("/")
    def index():
        return HTMLResponse(
            (WEB / "index.html").read_text().replace("/static/", asset_prefix + "/"),
            headers={"Cache-Control": "no-store"},
        )

    if WEB.exists():
        app.mount(asset_prefix, StaticFiles(directory=WEB), name="versioned-assets")
        app.mount("/static", StaticFiles(directory=WEB), name="static")

    return app
