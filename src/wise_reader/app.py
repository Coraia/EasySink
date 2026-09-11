from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from wise_reader.engine import Engine
from wise_reader.l1 import NullLLM, OpenAICompatLLM
from wise_reader.lexicon import Lexicon
from wise_reader.plugins import PluginContext, mount_plugins
from wise_reader.profile import DOMAINS, EXAM_VOCAB
from wise_reader.settings import ROOT, Settings
from wise_reader.store import Store
from wise_reader.vocab_test import VocabTester, question_payload

WEB = ROOT / "web"


class DocumentIn(BaseModel):
    text: str = Field(min_length=1)
    title: str = ""


class FeedbackIn(BaseModel):
    lemma: str
    verdict: str


class ProfilePatch(BaseModel):
    vocab_size: int | None = None
    density: float | None = None
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


def create_app() -> FastAPI:
    settings = Settings()
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
    tester = VocabTester(lexicon)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        lexicon.close()
        store.close()

    app = FastAPI(title="Wise Reader", lifespan=lifespan)
    app.state.engine = engine
    app.state.store = store
    app.state.tester = tester

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
            "l1_available": l1_on,
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
        p = store.update_profile(**fields)
        return get_profile()

    @app.post("/api/documents")
    def create_document(body: DocumentIn):
        profile = store.get_profile()
        return engine.ingest(body.title, body.text, profile)

    @app.get("/api/documents")
    def list_documents():
        return store.list_documents()

    @app.get("/api/documents/{doc_id}")
    def get_document(doc_id: int, density: float | None = None):
        profile = store.get_profile()
        try:
            return engine.present(doc_id, profile, density=density)
        except KeyError:
            raise HTTPException(404, "not found")

    @app.delete("/api/documents/{doc_id}")
    def delete_document(doc_id: int):
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
        if body.verdict not in ("known", "unknown"):
            raise HTTPException(400, "verdict")
        store.set_verdict(body.lemma, body.verdict, "feedback")
        return {"ok": True}

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
            raise HTTPException(404, "session")
        if session.finished and session.estimate:
            store.update_profile(vocab_size=session.estimate)
            for w in session.known_words:
                store.set_verdict(w, "known", "vocab_test")
        return question_payload(session)

    mount_plugins(
        app,
        PluginContext(store=store, engine=engine, llm=llm, l1_on=l1_on, settings=settings),
    )

    @app.get("/")
    def index():
        return FileResponse(WEB / "index.html")

    if WEB.exists():
        app.mount("/static", StaticFiles(directory=WEB), name="static")

    return app
