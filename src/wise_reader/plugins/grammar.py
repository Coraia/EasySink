from fastapi import APIRouter, Depends, Request

from wise_reader.plugins.runtime import require_plugin
from wise_reader.reading_assist import GrammarPlanIn, SelectionIn, assist, grammar_plan


def register(app, ctx):
    router = APIRouter(dependencies=[Depends(require_plugin("grammar"))])

    @router.post("/api/documents/{doc_id}/grammar")
    async def grammar(doc_id: int, body: SelectionIn, request: Request):
        return await assist(app, ctx, request, doc_id, "grammar", body.anchor, body.request_id)

    @router.post("/api/documents/{doc_id}/grammar/plan")
    def plan(doc_id: int, body: GrammarPlanIn):
        return grammar_plan(app, ctx, doc_id, body)

    app.include_router(router)
