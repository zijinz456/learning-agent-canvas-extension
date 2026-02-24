import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/learning_agent"
)

DOWNLOAD_DIR = os.getenv(
    "DOWNLOAD_DIR",
    os.path.expanduser("~/learning-agent-files")
)

LEARNING_AGENT_API_KEY = os.getenv("LEARNING_AGENT_API_KEY", "").strip()

CORS_ALLOW_ORIGINS = [
    origin.strip()
    for origin in os.getenv("CORS_ALLOW_ORIGINS", "").split(",")
    if origin.strip()
]

CORS_ALLOW_ORIGIN_REGEX = os.getenv(
    "CORS_ALLOW_ORIGIN_REGEX",
    r"^chrome-extension://[a-z]{32}$",
).strip() or None
