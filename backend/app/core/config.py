from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


ROOT_DIR = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="XFUSION_",
        env_file=str(ROOT_DIR / "backend" / ".env"),
        extra="ignore",
    )

    env: str = "development"
    app_name: str = "XFusion Agent"
    api_prefix: str = "/api"
    secret_key: str = Field(default="change-me")
    database_url: str = Field(
        default=f"sqlite:///{(ROOT_DIR / 'backend' / 'xfusion.db').as_posix()}"
    )
    claude_enabled: bool = True
    model: str = "anthropic/claude-sonnet-4-6"
    agent_shared_secret: str = "change-me-agent-secret"
    token_expire_minutes: int = 60 * 12
    frontend_origin: str = "http://localhost:5173"
    metric_collection_interval_seconds: int = 180


@lru_cache
def get_settings() -> Settings:
    return Settings()
