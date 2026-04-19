from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlmodel import Session, select

from ..models.entities import Host, HostMetricSample


def _parse_percent(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("%"):
        text = text[:-1]
    try:
        return round(float(text), 2)
    except Exception:
        return None


def _parse_load(metrics: dict[str, Any]) -> float | None:
    raw = metrics.get("load_average") or metrics.get("load")
    if isinstance(raw, list) and raw:
        try:
            return round(float(raw[0]), 2)
        except Exception:
            return None
    if isinstance(raw, str):
        parts = [part.strip() for part in raw.split(",") if part.strip()]
        if parts:
            try:
                return round(float(parts[0]), 2)
            except Exception:
                return None
    return None


def _coerce_top_processes(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    value = metrics.get("top_processes")
    if isinstance(value, list):
        return value[:10]
    return []


class MonitoringCoreService:
    @staticmethod
    def record_sample(
        session: Session,
        *,
        host: Host,
        metrics: dict[str, Any],
        source: str = "control-plane",
    ) -> HostMetricSample:
        sample = HostMetricSample(
            host_id=host.id,
            cpu_percent=_parse_percent(metrics.get("cpu_percent")),
            memory_percent=_parse_percent(metrics.get("memory", {}).get("percent") if isinstance(metrics.get("memory"), dict) else metrics.get("memory_percent")),
            root_disk_percent=_parse_percent(metrics.get("disk", {}).get("percent") if isinstance(metrics.get("disk"), dict) else metrics.get("disk_root")),
            load1=_parse_load(metrics),
            top_processes=_coerce_top_processes(metrics),
            source=source,
        )
        session.add(sample)
        session.commit()
        session.refresh(sample)
        return sample

    @staticmethod
    def _latest_sample(session: Session, host_id: int) -> HostMetricSample | None:
        return session.exec(
            select(HostMetricSample)
            .where(HostMetricSample.host_id == host_id)
            .order_by(HostMetricSample.sampled_at.desc())
            .limit(1)
        ).first()

    @classmethod
    def host_summary(cls, session: Session, host: Host) -> dict[str, Any]:
        latest = cls._latest_sample(session, host.id)
        metrics = host.metrics_json or {}
        memory_percent = _parse_percent(metrics.get("memory", {}).get("percent") if isinstance(metrics.get("memory"), dict) else metrics.get("memory_percent"))
        disk_percent = _parse_percent(metrics.get("disk", {}).get("percent") if isinstance(metrics.get("disk"), dict) else metrics.get("disk_root"))
        cpu_percent = _parse_percent(metrics.get("cpu_percent"))
        load1 = _parse_load(metrics)

        values = {
            "up": 1.0 if host.status in {"online", "registered"} else 0.0,
            "cpu_percent": latest.cpu_percent if latest and latest.cpu_percent is not None else cpu_percent,
            "memory_percent": latest.memory_percent if latest and latest.memory_percent is not None else memory_percent,
            "root_disk_percent": latest.root_disk_percent if latest and latest.root_disk_percent is not None else disk_percent,
            "load1": latest.load1 if latest and latest.load1 is not None else load1,
        }
        return {
            "available": any(value is not None for key, value in values.items() if key != "up"),
            "instance": host.address,
            "sampled_at": latest.sampled_at.isoformat() if latest else None,
            "values": values,
            "top_processes": latest.top_processes if latest else _coerce_top_processes(metrics),
        }

    @classmethod
    def host_timeseries(cls, session: Session, host: Host, hours: int = 6) -> dict[str, Any]:
        hours = max(1, min(hours, 48))
        cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
        samples = list(
            session.exec(
                select(HostMetricSample)
                .where(HostMetricSample.host_id == host.id)
                .where(HostMetricSample.sampled_at >= cutoff)
                .order_by(HostMetricSample.sampled_at.asc())
            ).all()
        )
        series = {
            "cpu_percent": [],
            "memory_percent": [],
            "root_disk_percent": [],
        }
        for sample in samples:
            timestamp = int(sample.sampled_at.timestamp())
            if sample.cpu_percent is not None:
                series["cpu_percent"].append({"timestamp": timestamp, "value": sample.cpu_percent})
            if sample.memory_percent is not None:
                series["memory_percent"].append({"timestamp": timestamp, "value": sample.memory_percent})
            if sample.root_disk_percent is not None:
                series["root_disk_percent"].append({"timestamp": timestamp, "value": sample.root_disk_percent})
        return {
            "available": any(series.values()),
            "instance": host.address,
            "hours": hours,
            "series": series,
        }

    @classmethod
    def internal_capabilities(cls, session: Session) -> dict[str, Any]:
        hosts = list(session.exec(select(Host)).all())
        samples = list(session.exec(select(HostMetricSample).order_by(HostMetricSample.sampled_at.desc()).limit(200)).all())
        coverage = len({sample.host_id for sample in samples})
        return {
            "providers": [
                {
                    "key": "monitoring-core",
                    "name": "Monitoring Core",
                    "category": "observability",
                    "description": "内建的主机指标采样、历史曲线和资源摘要模块。",
                    "status": {"enabled": True, "reachable": True},
                    "stats": {"hosts": len(hosts), "hosts_with_samples": coverage, "samples": len(samples)},
                },
                {
                    "key": "policy-core",
                    "name": "Policy Core",
                    "category": "security",
                    "description": "内建风险判定、审批门禁和危险动作阻断模块。",
                    "status": {"enabled": True, "reachable": True},
                    "stats": {"blocked_actions": 3, "approval_actions": 4},
                },
                {
                    "key": "service-inventory",
                    "name": "Service Inventory",
                    "category": "inventory",
                    "description": "内建服务发现、容器识别和运行时拓扑汇总模块。",
                    "status": {"enabled": True, "reachable": True},
                    "stats": {"hosts": len(hosts)},
                },
                {
                    "key": "voice-console",
                    "name": "Voice Console",
                    "category": "interaction",
                    "description": "内建浏览器语音输入与结果播报，支撑去命令行化体验。",
                    "status": {"enabled": True, "reachable": True},
                    "stats": {"modes": 2},
                },
            ],
            "actions": [
                {
                    "key": "collect-snapshots",
                    "title": "采集全量主机快照",
                    "description": "立即采集所有纳管主机的 CPU、内存、磁盘和高占用进程快照。",
                }
            ],
        }
