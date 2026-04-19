from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import HTTPException
from sqlmodel import Session, select

from ..core.config import ROOT_DIR, get_settings
from ..models.entities import Host


settings = get_settings()
FILE_SD_PATH = ROOT_DIR / "infra" / "prometheus" / "file_sd" / "node_exporters.json"


def _prometheus_base_url() -> str | None:
    return (settings.prometheus_internal_url or settings.prometheus_url or "").rstrip("/") or None


class PrometheusService:
    @staticmethod
    def _instance(host: Host) -> str:
        return f"{host.address}:{settings.node_exporter_port}"

    @staticmethod
    def _escape(value: str) -> str:
        return value.replace("\\", "\\\\").replace('"', '\\"')

    @classmethod
    def build_target_groups(cls, session: Session) -> list[dict[str, Any]]:
        hosts = list(session.exec(select(Host).order_by(Host.id.asc())).all())
        groups: list[dict[str, Any]] = []
        for host in hosts:
            groups.append(
                {
                    "targets": [cls._instance(host)],
                    "labels": {
                        "host_id": str(host.id),
                        "host_name": host.name,
                        "environment": host.environment,
                    },
                }
            )
        return groups

    @classmethod
    def sync_targets(cls, session: Session) -> dict[str, Any]:
        groups = cls.build_target_groups(session)
        FILE_SD_PATH.parent.mkdir(parents=True, exist_ok=True)
        FILE_SD_PATH.write_text(json.dumps(groups, ensure_ascii=False, indent=2), encoding="utf-8")
        reload_result = cls.reload()
        return {
            "path": str(FILE_SD_PATH),
            "targets": groups,
            "reload": reload_result,
        }

    @staticmethod
    def reload() -> dict[str, Any]:
        base_url = _prometheus_base_url()
        if not base_url:
            return {"configured": False, "reloaded": False, "error": "Prometheus URL not configured"}

        try:
            response = httpx.post(f"{base_url}/-/reload", timeout=4.0)
            return {
                "configured": True,
                "reloaded": response.status_code < 300,
                "status_code": response.status_code,
                "error": None if response.status_code < 300 else response.text,
            }
        except Exception as exc:
            return {
                "configured": True,
                "reloaded": False,
                "status_code": None,
                "error": str(exc),
            }

    @staticmethod
    def _query(expr: str) -> list[dict[str, Any]]:
        base_url = _prometheus_base_url()
        if not base_url:
            raise HTTPException(status_code=503, detail="Prometheus is not configured")
        response = httpx.get(
            f"{base_url}/api/v1/query",
            params={"query": expr},
            timeout=5.0,
        )
        response.raise_for_status()
        payload = response.json()
        return payload.get("data", {}).get("result", [])

    @staticmethod
    def _query_range(expr: str, start: int, end: int, step: str = "60s") -> list[dict[str, Any]]:
        base_url = _prometheus_base_url()
        if not base_url:
            raise HTTPException(status_code=503, detail="Prometheus is not configured")
        response = httpx.get(
            f"{base_url}/api/v1/query_range",
            params={"query": expr, "start": start, "end": end, "step": step},
            timeout=8.0,
        )
        response.raise_for_status()
        payload = response.json()
        return payload.get("data", {}).get("result", [])

    @staticmethod
    def _single_value(results: list[dict[str, Any]]) -> float | None:
        if not results:
            return None
        value = results[0].get("value")
        if not value or len(value) < 2:
            return None
        try:
            return float(value[1])
        except Exception:
            return None

    @classmethod
    def host_summary(cls, host: Host) -> dict[str, Any]:
        instance = cls._escape(cls._instance(host))
        expressions = {
            "up": f'up{{instance="{instance}"}}',
            "cpu_percent": f'100 * (1 - avg(rate(node_cpu_seconds_total{{mode="idle",instance="{instance}"}}[5m])))',
            "memory_percent": f'100 * (1 - (node_memory_MemAvailable_bytes{{instance="{instance}"}} / node_memory_MemTotal_bytes{{instance="{instance}"}}))',
            "root_disk_percent": f'100 * (1 - (node_filesystem_avail_bytes{{instance="{instance}",mountpoint="/",fstype!=""}} / node_filesystem_size_bytes{{instance="{instance}",mountpoint="/",fstype!=""}}))',
            "load1": f'node_load1{{instance="{instance}"}}',
        }
        summary = {
            "available": True,
            "instance": cls._instance(host),
            "values": {},
        }
        for key, expr in expressions.items():
            try:
                summary["values"][key] = cls._single_value(cls._query(expr))
            except Exception as exc:
                summary["available"] = False
                summary["error"] = str(exc)
                summary["values"][key] = None
        return summary

    @classmethod
    def host_timeseries(cls, host: Host, hours: int = 6) -> dict[str, Any]:
        hours = max(1, min(hours, 48))
        end = int(time.time())
        start = end - hours * 3600
        instance = cls._escape(cls._instance(host))
        expressions = {
            "cpu_percent": f'100 * (1 - avg(rate(node_cpu_seconds_total{{mode="idle",instance="{instance}"}}[5m])))',
            "memory_percent": f'100 * (1 - (node_memory_MemAvailable_bytes{{instance="{instance}"}} / node_memory_MemTotal_bytes{{instance="{instance}"}}))',
            "root_disk_percent": f'100 * (1 - (node_filesystem_avail_bytes{{instance="{instance}",mountpoint="/",fstype!=""}} / node_filesystem_size_bytes{{instance="{instance}",mountpoint="/",fstype!=""}}))',
        }
        series_map: dict[str, list[dict[str, Any]]] = {}
        for key, expr in expressions.items():
            try:
                results = cls._query_range(expr, start=start, end=end, step="60s")
                values = results[0].get("values", []) if results else []
                series_map[key] = [
                    {"timestamp": int(item[0]), "value": round(float(item[1]), 2)}
                    for item in values
                ]
            except Exception:
                series_map[key] = []
        return {
            "available": any(series_map.values()),
            "instance": cls._instance(host),
            "hours": hours,
            "series": series_map,
        }
