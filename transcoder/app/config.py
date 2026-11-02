from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="TR_", extra="ignore")

    torrents_path: str = "/torrents"
    work_dir: str = "/transcode"
    max_sessions: int = 4
    host: str = "0.0.0.0"
    port: int = 8091
    torrent_engine_url: str = "http://torrent-engine:8090"


settings = Settings()
