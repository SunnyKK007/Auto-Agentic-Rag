"""Configuration settings for the Agentic RAG system."""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Application settings, loaded from environment variables or .env file.
    
    Attributes:
        gemini_api_key: The API key for Google Gemini.
        ollama_base_url: The base URL for the local Ollama instance (if used).
        chunk_size: The default chunk size for document text splitting.
        chunk_overlap: The default chunk overlap for document text splitting.
        chroma_db_dir: The directory path for storing the ChromaDB vectors.
        use_local_llm: Flag indicating whether to use local Ollama model instead of Gemini.
    """
    gemini_api_key: str = ""
    api_key: str = ""
    ollama_base_url: str = "http://localhost:11434"
    chunk_size: int = 800
    chunk_overlap: int = 80  # 10% of 800
    min_relevance_score: float = 0.40
    # In production (Fly.io) this is overridden by the [env] block in fly.toml
    # pointing to the persistent volume at /data/chroma_db.
    # Locally it falls back to ./chroma_db for development.
    chroma_db_dir: str = "./chroma_db"
    use_local_llm: bool = False
    # Comma-separated list of allowed CORS origins.
    # Set to your Vercel URL in production, e.g. "https://your-app.vercel.app"
    allowed_origins: str = "*"

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")


settings = Settings()
