from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    torapi_url: str = "http://torapi:8443"
    torrserver_url: str = "http://torrserver:8090"
    torrserver_public_url: str = "http://localhost:8090"
    torrents_save_path: str = "/torrents"
    database_path: str = "/data/orchestrator.sqlite3"
    search_timeout: float = 60.0
    play_metadata_timeout: float = 120.0
