from __future__ import annotations

import asyncio
import contextlib
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api.routes import router
from .core.config import get_settings
from .core.database import engine, init_db, session_scope
from .services.monitoring import MonitoringCoreService
from .services.platform import HostInspector, HostRepository, now


settings = get_settings()


def bootstrap_database() -> None:
    init_db()


async def metric_collection_loop() -> None:
    while True:
        try:
            with session_scope() as session:
                hosts = HostRepository.list_hosts(session)
                for host in hosts:
                    credential = HostRepository.get_credential(session, host.id)
                    try:
                        metrics = await HostInspector.metrics(host, credential)
                        host.metrics_json = metrics
                        metrics_success = (metrics.get("raw") or {}).get("success") is not False
                        if metrics_success:
                            host.status = "online"
                            host.last_seen_at = now()
                        else:
                            host.status = "offline"
                        session.add(host)
                        session.commit()
                        MonitoringCoreService.record_sample(session, host=host, metrics=metrics, source="background-loop")
                    except Exception:
                        continue
        except Exception:
            pass
        await asyncio.sleep(max(settings.metric_collection_interval_seconds, 60))


@asynccontextmanager
async def lifespan(_: FastAPI):
    bootstrap_database()
    collector = asyncio.create_task(metric_collection_loop())
    try:
        yield
    finally:
        collector.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await collector


bootstrap_database()

app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        settings.frontend_origin,
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router, prefix=settings.api_prefix)
