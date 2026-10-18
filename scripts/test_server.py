"""Browser acceptance always uses a disposable database, never data/user.db."""

import os
import signal
import sys
import tempfile
from pathlib import Path

import uvicorn

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tests/browser"))
from provider_fixture import Provider


def create_test_app():
    from collections import deque
    from wise_reader.app import create_app
    from wise_reader.settings import Settings

    directory = os.environ.get("WR_E2E_DATA_DIR")
    if not directory:
        raise RuntimeError("Browser tests require a disposable WR_E2E_DATA_DIR")
    data_dir = Path(directory).resolve()
    os.environ["WR_PDF_DATA_DIR"] = str(data_dir / "user-pdf")
    os.environ["WR_NATIVE_TRACKPAD"] = "0"  # Never bind test pages to physical input.
    provider_port = int(os.environ.get("WR_E2E_PROVIDER_PORT", "18768"))
    settings = Settings(
        _env_file=None,
        wr_user_db=str(data_dir / "user.db"),
        wr_llm_enabled=False,
        wr_llm_provider="fixture",
        wr_llm_api_key="",
        wr_llm_base_url=f"http://127.0.0.1:{provider_port}/v1",
        wr_llm_model="e2e-model",
    )
    app = create_app(settings)
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
    # Uvicorn replays SIGTERM after graceful shutdown. Unwind our outer resource
    # contexts when it does, so the provider and temporary library are removed.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with (
        Provider(),
        tempfile.TemporaryDirectory(prefix="wise-reader-e2e-") as directory,
    ):
        os.environ["WR_E2E_DATA_DIR"] = directory
        uvicorn.run(
            create_test_app,
            factory=True,
            host="127.0.0.1",
            port=int(os.environ.get("WR_E2E_PORT", "18767")),
            log_level="warning",
        )
