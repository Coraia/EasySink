from pathlib import Path

import pytest

from wise_reader.lexicon import Lexicon

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="session")
def lexicon():
    lx = Lexicon()
    yield lx
    lx.close()


def fixture_text(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")
