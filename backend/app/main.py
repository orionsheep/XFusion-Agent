from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select

from .api.routes import router
from .core.config import get_settings
from .core.database import engine, init_db
from .models.entities import User
from .services.security import hash_password


settings = get_settings()


def bootstrap_database() -> None:
    init_db()
    with Session(engine) as session:
        existing = session.exec(select(User).where(User.username == settings.default_admin_username)).first()
        if not existing:
            session.add(
                User(
                    username=settings.default_admin_username,
                    password_hash=hash_password(settings.default_admin_password),
                    role="admin",
                )
            )
            session.commit()


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap_database()
    yield


bootstrap_database()

app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin, "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router, prefix=settings.api_prefix)
