from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(PROJECT_ROOT / "backend" / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: str = "development"
    api_prefix: str = "/api/v1"
    mindful_secret_key: str = Field(min_length=32)
    database_url: str = f"sqlite:///{(PROJECT_ROOT / 'backend' / 'data' / 'mindful.db').as_posix()}"
    voice_storage_path: Path = Path.home() / ".mindful" / "private_voice_samples"
    access_token_minutes: int = Field(default=20, ge=5, le=120)
    cookie_secure: bool | None = None
    frontend_origins: str = "http://localhost:5500,http://127.0.0.1:5500"
    max_voice_sample_bytes: int = Field(default=10 * 1024 * 1024, ge=1024, le=50 * 1024 * 1024)
    consent_text_version: str = "voice-sample-consent-v2"
    rate_limit_storage_uri: str = "memory://"
    allowed_hosts: str = "localhost,127.0.0.1"
    audit_retention_days: int = Field(default=365, ge=365)
    max_export_bytes: int = Field(default=100 * 1024 * 1024, ge=1024 * 1024)

    @field_validator("mindful_secret_key")
    @classmethod
    def validate_secret_strength(cls, value: str) -> str:
        if value.lower().startswith(("replace-with", "change-me", "changeme")):
            raise ValueError("MINDFUL_SECRET_KEY must be replaced with a random secret")
        return value

    @field_validator("voice_storage_path")
    @classmethod
    def private_voice_storage(cls, value: Path) -> Path:
        resolved = value.expanduser().resolve()
        if resolved == PROJECT_ROOT or PROJECT_ROOT in resolved.parents:
            raise ValueError("VOICE_STORAGE_PATH must be outside the project/web root")
        return resolved

    @model_validator(mode="after")
    def validate_production_settings(self):
        if self.app_env.lower() == "production":
            if self.database_url.startswith("sqlite:"):
                raise ValueError("Production requires PostgreSQL")
            if "sslmode=verify-full" not in self.database_url.lower():
                raise ValueError("Production PostgreSQL connections must verify TLS certificates")
            if not self.secure_cookies:
                raise ValueError("Production requires Secure cookies")
            if self.rate_limit_storage_uri.startswith("memory:"):
                raise ValueError("Production requires shared Redis rate-limit storage")
            if not self.rate_limit_storage_uri.startswith("rediss://"):
                raise ValueError("Production Redis rate-limit storage must use TLS")
            if any("localhost" in host or "127.0.0.1" in host for host in self.cors_origins):
                raise ValueError("Production FRONTEND_ORIGINS must contain only deployed HTTPS origins")
            if not self.cors_origins or any(not origin.startswith("https://") for origin in self.cors_origins):
                raise ValueError("Production frontend origins must use HTTPS")
            if not self.host_names or any(host in {"localhost", "127.0.0.1", "*"} for host in self.host_names):
                raise ValueError("Production ALLOWED_HOSTS must list deployed hostnames explicitly")
        return self

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip().rstrip("/") for origin in self.frontend_origins.split(",") if origin.strip()]

    @property
    def host_names(self) -> list[str]:
        return [host.strip() for host in self.allowed_hosts.split(",") if host.strip()]

    @property
    def secure_cookies(self) -> bool:
        return self.cookie_secure if self.cookie_secure is not None else self.app_env.lower() in {"production", "staging"}

    def resolve_path(self, path: Path) -> Path:
        return path if path.is_absolute() else PROJECT_ROOT / path


@lru_cache
def get_settings() -> Settings:
    return Settings()
