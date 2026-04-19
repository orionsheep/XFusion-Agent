from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote

import httpx

from ..core.config import get_settings
from ..models.entities import Host


def _normalize(url: str | None) -> str | None:
    if not url:
        return None
    return url.rstrip("/")


class IntegrationCatalog:
    @staticmethod
    async def _probe(url: str | None, path: str = "") -> dict[str, Any]:
        normalized = _normalize(url)
        if not normalized:
            return {
                "configured": False,
                "reachable": False,
                "status_code": None,
                "checked_url": None,
                "error": None,
            }

        target = f"{normalized}{path}"
        timeout = httpx.Timeout(4.0, connect=2.0)
        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                response = await client.get(target)
            return {
                "configured": True,
                "reachable": response.status_code < 500,
                "status_code": response.status_code,
                "checked_url": target,
                "error": None,
            }
        except Exception as exc:
            return {
                "configured": True,
                "reachable": False,
                "status_code": None,
                "checked_url": target,
                "error": str(exc),
            }

    @classmethod
    async def summary(cls) -> dict[str, Any]:
        settings = get_settings()
        beszel_status, prometheus_status, portainer_status = await asyncio.gather(
            cls._probe(settings.beszel_internal_url or settings.beszel_url),
            cls._probe(settings.prometheus_internal_url or settings.prometheus_url, "/-/healthy"),
            cls._probe(settings.portainer_internal_url or settings.portainer_url),
        )
        return {
            "providers": [
                {
                    "key": "beszel",
                    "name": "Beszel",
                    "category": "monitoring",
                    "description": "多机性能监控、历史数据、告警、容器统计。",
                    "url": _normalize(settings.beszel_url),
                    "status": beszel_status,
                    "scope": "global",
                },
                {
                    "key": "prometheus",
                    "name": "Prometheus",
                    "category": "metrics",
                    "description": "标准指标查询与 Node Exporter 抓取层。",
                    "url": _normalize(settings.prometheus_url),
                    "status": prometheus_status,
                    "scope": "global",
                },
                {
                    "key": "portainer",
                    "name": "Portainer CE",
                    "category": "container-management",
                    "description": "Docker / Swarm / Kubernetes 环境管理。",
                    "url": _normalize(settings.portainer_url),
                    "status": portainer_status,
                    "scope": "global",
                },
                {
                    "key": "cockpit",
                    "name": "Cockpit",
                    "category": "server-management",
                    "description": "整机服务、日志、网络、存储和终端管理。",
                    "url": None,
                    "status": {
                        "configured": True,
                        "reachable": None,
                        "status_code": None,
                        "checked_url": None,
                        "error": "Cockpit 按主机安装，不提供统一中心地址。",
                    },
                    "scope": "per-host",
                },
                {
                    "key": "node_exporter",
                    "name": "Node Exporter",
                    "category": "metrics-agent",
                    "description": "Linux 主机标准指标出口，供 Prometheus 抓取。",
                    "url": None,
                    "status": {
                        "configured": True,
                        "reachable": None,
                        "status_code": None,
                        "checked_url": None,
                        "error": "Node Exporter 按主机安装，不提供统一中心地址。",
                    },
                    "scope": "per-host",
                },
            ],
            "deployment_templates": [
                {
                    "key": "beszel-hub",
                    "title": "启动 Beszel Hub",
                    "command": "docker compose up -d beszel",
                },
                {
                    "key": "prometheus",
                    "title": "启动 Prometheus",
                    "command": "docker compose up -d prometheus",
                },
                {
                    "key": "portainer",
                    "title": "启动 Portainer CE",
                    "command": "docker compose up -d portainer",
                },
                {
                    "key": "cockpit",
                    "title": "在 Linux 主机安装 Cockpit",
                    "command": "bash infra/scripts/install-cockpit.sh",
                },
                {
                    "key": "node_exporter",
                    "title": "在 Linux 主机安装 Node Exporter",
                    "command": "bash infra/scripts/install-node-exporter.sh",
                },
                {
                    "key": "beszel-agent",
                    "title": "在 Linux 主机安装 Beszel Agent",
                    "command": "KEY='<public-key>' TOKEN='<token>' HUB_URL='http://<hub-host>:8090' bash infra/scripts/install-beszel-agent.sh",
                },
            ],
        }

    @staticmethod
    def host_links(host: Host) -> list[dict[str, Any]]:
        settings = get_settings()
        links: list[dict[str, Any]] = []
        cockpit_url = f"{settings.cockpit_scheme}://{host.address}:{settings.cockpit_port}"
        node_exporter_url = f"{settings.node_exporter_scheme}://{host.address}:{settings.node_exporter_port}/metrics"
        links.append(
            {
                "key": "cockpit",
                "title": "Cockpit",
                "category": "server-management",
                "url": cockpit_url,
                "description": "整机服务、日志、网络、存储、终端。",
            }
        )
        links.append(
            {
                "key": "node_exporter",
                "title": "Node Exporter",
                "category": "metrics-agent",
                "url": node_exporter_url,
                "description": "Prometheus 抓取用的主机指标出口。",
            }
        )

        if settings.beszel_url:
            links.append(
                {
                    "key": "beszel",
                    "title": "Beszel Hub",
                    "category": "monitoring",
                    "url": _normalize(settings.beszel_url),
                    "description": "查看历史指标、告警和容器统计。",
                }
            )

        if settings.prometheus_url:
            expression = quote(f'up{{instance="{host.address}:{settings.node_exporter_port}"}}')
            links.append(
                {
                    "key": "prometheus",
                    "title": "Prometheus Graph",
                    "category": "metrics",
                    "url": f"{_normalize(settings.prometheus_url)}/graph?g0.expr={expression}&g0.tab=1",
                    "description": "直接查看该主机的抓取状态与指标查询。",
                }
            )

        has_container_runtime = bool(host.profile_json.get("docker") or host.profile_json.get("podman"))
        if settings.portainer_url and has_container_runtime:
            links.append(
                {
                    "key": "portainer",
                    "title": "Portainer CE",
                    "category": "container-management",
                    "url": _normalize(settings.portainer_url),
                    "description": "进入容器管理平台查看镜像、容器、网络与卷。",
                }
            )

        return links
