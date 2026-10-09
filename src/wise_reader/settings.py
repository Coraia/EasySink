from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    wr_llm_enabled: bool = False
    wr_llm_provider: str = "deepseek"
    wr_llm_api_key: str = ""
    wr_llm_base_url: str = "https://api.deepseek.com"
    wr_llm_model: str = "deepseek-chat"
    wr_user_db: str = ""

    @classmethod
    def desktop(cls, data_dir: Path) -> "Settings":
        """Desktop bootstrap clears inherited environment before calling this."""
        return cls(_env_file=None, wr_user_db=str(data_dir / "user.db"),
                   wr_llm_enabled=False, wr_llm_api_key="")
