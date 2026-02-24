from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .core.database import engine, Base
from .core.config import CORS_ALLOW_ORIGINS, CORS_ALLOW_ORIGIN_REGEX
from .api import sync, query, export

# Create tables on startup
Base.metadata.create_all(bind=engine)

app = FastAPI(title="Learning Agent Backend", version="0.1.0")

# Allow Chrome extension to call us
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_origin_regex=CORS_ALLOW_ORIGIN_REGEX,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sync.router)
app.include_router(query.router)
app.include_router(export.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
