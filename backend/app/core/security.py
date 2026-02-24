from fastapi import Header, HTTPException

from .config import LEARNING_AGENT_API_KEY


def require_api_key(
    x_learning_agent_key: str | None = Header(default=None, alias="X-Learning-Agent-Key"),
):
    """Require a shared API key when LEARNING_AGENT_API_KEY is configured."""
    if not LEARNING_AGENT_API_KEY:
        return

    if x_learning_agent_key != LEARNING_AGENT_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")
