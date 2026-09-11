from __future__ import annotations

import importlib
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from wise_reader.engine import Engine
from wise_reader.l1 import LLMClient
from wise_reader.plugins.catalog import BY_ID, PLUGINS
from wise_reader.settings import Settings
from wise_reader.store import Store


@dataclass
class PluginContext:
    store: Store
    engine: Engine
    llm: LLMClient
    l1_on: bool
    settings: Settings


class PluginPatch(BaseModel):
    enabled: bool


def require_plugin(plugin_id: str):
    spec = BY_ID[plugin_id]

    def _dep(request: Request) -> None:
        store: Store = request.app.state.store
        if not store.is_plugin_enabled(plugin_id, spec.default_on):
            raise HTTPException(404, f"plugin {plugin_id} is off")

    return _dep


def plugin_payload(store: Store) -> list[dict]:
    flags = store.plugin_flags()
    out = []
    for spec in PLUGINS:
        enabled = flags[spec.id] if spec.id in flags else spec.default_on
        out.append(
            {
                "id": spec.id,
                "name": spec.name,
                "summary": spec.summary,
                "enabled": bool(enabled),
                "default_on": spec.default_on,
                "backend": spec.backend is not None,
            }
        )
    return out


def mount_plugins(app: FastAPI, ctx: PluginContext) -> None:
    app.state.plugin_ctx = ctx
    for spec in PLUGINS:
        if not spec.backend:
            continue
        mod = importlib.import_module(f"wise_reader.plugins.{spec.backend}")
        if hasattr(mod, "migrate"):
            mod.migrate(ctx.store)
        if hasattr(mod, "register"):
            mod.register(app, ctx)

    @app.get("/api/plugins")
    def list_plugins():
        return {"plugins": plugin_payload(ctx.store)}

    @app.patch("/api/plugins/{plugin_id}")
    def patch_plugin(plugin_id: str, body: PluginPatch):
        if plugin_id not in BY_ID:
            raise HTTPException(404, "unknown plugin")
        ctx.store.set_plugin_enabled(plugin_id, body.enabled)
        return {"plugins": plugin_payload(ctx.store)}
