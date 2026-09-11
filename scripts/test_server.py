"""Browser acceptance always uses a disposable database, never data/user.db."""

import os
import tempfile
import uvicorn

if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="wise-reader-e2e-") as directory:
        os.environ["WR_USER_DB"] = directory + "/user.db"
        os.environ["WR_LLM_ENABLED"] = "false"
        uvicorn.run(
            "wise_reader.app:create_app",
            factory=True,
            host="127.0.0.1",
            port=18767,
            log_level="warning",
        )
