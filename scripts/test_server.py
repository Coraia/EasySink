"""Browser acceptance always uses a disposable database, never data/user.db."""

import os
import sys
import tempfile
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests/browser"))
from provider_fixture import Provider


def create_test_app():
    from collections import deque
    from wise_reader.app import create_app
    app = create_app()
    app.state.assist_debug = deque(maxlen=256)

    @app.get("/__e2e/assist-debug")
    async def assist_debug():
        return list(app.state.assist_debug)

    @app.get("/__e2e/assists")
    async def assist_states():
        # Read-only readiness witness for concurrency checks. Only disposable
        # test service exposes it; neither source text nor credentials are sent.
        return [{"doc_id": doc_id, "request_id": rid,
                 "cancelled": state["cancelled"],
                 "consumers": len(state.get("flight", {}).get("owners", {}))}
                for (doc_id, rid), state in app.state.assist_requests.items()]

    return app

if __name__ == "__main__":
    with (
        Provider(),
        tempfile.TemporaryDirectory(prefix="wise-reader-e2e-") as directory,
    ):
        os.environ["WR_USER_DB"] = directory + "/user.db"
        os.environ["WR_LLM_ENABLED"] = "false"
        os.environ["WR_NATIVE_TRACKPAD"] = "0" # Never bind test pages to physical input.
        uvicorn.run(
            create_test_app,
            factory=True,
            host="127.0.0.1",
            port=18767,
            log_level="warning",
        )
