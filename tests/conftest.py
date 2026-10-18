from pathlib import Path

import pytest

from wise_reader.lexicon import Lexicon
from wise_reader.settings import Settings

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path, monkeypatch):
    """API scenarios must not inherit personal credentials, storage or devices."""
    monkeypatch.setitem(Settings.model_config, "env_file", None)
    for name, value in {
        "WR_USER_DB": str(tmp_path / "user.db"),
        "WR_PDF_DATA_DIR": str(tmp_path / "user-pdf"),
        "WR_NATIVE_TRACKPAD": "0",
        "WR_LLM_ENABLED": "false",
        "WR_LLM_API_KEY": "",
        "WR_LLM_PROVIDER": "fixture",
        "WR_LLM_BASE_URL": "http://127.0.0.1:1/v1",
        "WR_LLM_MODEL": "fixture-model",
    }.items():
        monkeypatch.setenv(name, value)


@pytest.fixture(scope="session")
def lexicon():
    lx = Lexicon()
    yield lx
    lx.close()


def fixture_text(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")
