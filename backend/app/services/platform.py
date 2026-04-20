from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import asyncssh
import httpx
from .llm_router import LLMMessage, registry
from fastapi import HTTPException, status
from sqlalchemy import inspect as sa_inspect
from sqlalchemy import delete
from sqlmodel import Session, select

from ..core.config import get_settings
from ..models.entities import (
    AgentNode,
    Approval,
    AuditLog,
    Host,
    HostCredential,
    Service,
    Task,
    TaskStep,
    User,
)
from .security import decrypt_secret, encrypt_secret


settings = get_settings()


def now() -> datetime:
    return datetime.now(timezone.utc)


def jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value, default=str))


def serialize_model(instance: Any) -> dict[str, Any]:
    if instance is None:
        return {}
    try:
        mapper = sa_inspect(type(instance))
        payload = {column.key: getattr(instance, column.key) for column in mapper.columns}
        return jsonable(payload)
    except Exception:
        return jsonable(
            {
                key: value
                for key, value in vars(instance).items()
                if not key.startswith("_")
            }
        )


def _extract_ports_from_text(value: str) -> list[int]:
    ports = {int(match) for match in re.findall(r":(\d+)(?:->|\s)", value or "")}
    return sorted(ports)


def _extract_ports_from_docker_inspect(item: dict[str, Any]) -> list[int]:
    ports: set[int] = set()
    port_map = item.get("NetworkSettings", {}).get("Ports") or {}
    if isinstance(port_map, dict):
        for container_port, bindings in port_map.items():
            base = str(container_port).split("/", 1)[0]
            if base.isdigit():
                ports.add(int(base))
            if isinstance(bindings, list):
                for binding in bindings:
                    host_port = str((binding or {}).get("HostPort") or "")
                    if host_port.isdigit():
                        ports.add(int(host_port))
    return sorted(ports)


def _extract_pm2_ports(pm2_env: dict[str, Any]) -> list[int]:
    ports: set[int] = set()
    env = pm2_env.get("env") if isinstance(pm2_env.get("env"), dict) else {}
    for key, value in env.items():
        if "PORT" in str(key).upper():
            text = str(value).strip()
            if text.isdigit():
                ports.add(int(text))
    return sorted(ports)


def _detect_database_engine(name: str, ports: list[int], evidence: dict[str, Any]) -> str | None:
    haystack_parts = [name]
    for key in ("raw", "image", "project", "service", "namespace"):
        value = evidence.get(key)
        if isinstance(value, str):
            haystack_parts.append(value)
    labels = evidence.get("labels")
    if isinstance(labels, dict):
        haystack_parts.extend(str(value) for value in labels.values())
    containers = evidence.get("containers")
    if isinstance(containers, list):
        for item in containers:
            if isinstance(item, dict):
                haystack_parts.extend(str(item.get(key) or "") for key in ("name", "image"))
    text = " ".join(haystack_parts).lower()
    port_set = set(ports)
    if "mariadb" in text:
        return "mariadb"
    if "mysql" in text or 3306 in port_set:
        return "mysql"
    if "postgres" in text or "postgresql" in text or 5432 in port_set:
        return "postgresql"
    if "redis" in text or 6379 in port_set:
        return "redis"
    if "mongo" in text or 27017 in port_set:
        return "mongodb"
    if "elasticsearch" in text or 9200 in port_set or 9300 in port_set:
        return "elasticsearch"
    if "clickhouse" in text or 8123 in port_set or 9000 in port_set:
        return "clickhouse"
    if "etcd" in text or 2379 in port_set or 2380 in port_set:
        return "etcd"
    return None


def _annotate_service(item: dict[str, Any]) -> dict[str, Any]:
    evidence = item.get("evidence_json")
    if not isinstance(evidence, dict):
        evidence = {}
        item["evidence_json"] = evidence
    engine = _detect_database_engine(item.get("name", ""), item.get("ports", []) or [], evidence)
    if engine:
        evidence["workload"] = "database"
        evidence["database_engine"] = engine
    elif item.get("runtime_type") == "kubernetes":
        evidence["workload"] = "kubernetes-workload"
    elif item.get("runtime_type") in {"docker", "docker-compose", "podman"}:
        evidence.setdefault("workload", "container-service")
    elif item.get("runtime_type") == "pm2":
        evidence.setdefault("workload", "pm2-application")
    elif item.get("runtime_type") == "supervisor":
        evidence.setdefault("workload", "supervised-program")
    elif item.get("runtime_type") == "systemd":
        evidence.setdefault("workload", "system-service")
    return item


def upsert_audit(
    session: Session,
    *,
    actor_id: int | None,
    event_type: str,
    task_id: int | None = None,
    host_id: int | None = None,
    payload: dict[str, Any] | None = None,
) -> AuditLog:
    audit = AuditLog(
        actor_id=actor_id,
        task_id=task_id,
        host_id=host_id,
        event_type=event_type,
        payload_json=jsonable(payload or {}),
    )
    session.add(audit)
    session.commit()
    session.refresh(audit)
    return audit


class HostRepository:
    @staticmethod
    def create_host(session: Session, payload: dict[str, Any]) -> Host:
        host = Host(
            name=payload["name"],
            address=payload["address"],
            ssh_port=payload.get("ssh_port", 22),
            username=payload.get("username", "root"),
            connection_mode=payload.get("connection_mode", "hybrid"),
            auth_type=payload.get("auth_type", "key"),
            environment=payload.get("environment", "production"),
            labels=payload.get("labels", []),
            risk_level=payload.get("risk_level", "medium"),
            agent_url=payload.get("agent_url"),
        )
        session.add(host)
        session.commit()
        session.refresh(host)

        secret = payload.get("ssh_private_key") or payload.get("ssh_password")
        if secret:
            cred = HostCredential(
                host_id=host.id,
                auth_type=payload.get("auth_type", "key"),
                encrypted_secret=encrypt_secret(secret),
            )
            session.add(cred)
            session.commit()

        if host.agent_url:
            registration_token = uuid.uuid4().hex
            agent = AgentNode(
                host_id=host.id,
                identity=f"agent-{host.id}",
                registration_token=registration_token,
                status="registered",
            )
            session.add(agent)
            session.commit()
        session.refresh(host)
        return host

    @staticmethod
    def list_hosts(session: Session) -> list[Host]:
        return list(session.exec(select(Host).order_by(Host.id.desc())).all())

    @staticmethod
    def get_host(session: Session, host_id: int) -> Host:
        host = session.get(Host, host_id)
        if not host:
            raise HTTPException(status_code=404, detail="Host not found")
        return host

    @staticmethod
    def get_credential(session: Session, host_id: int) -> HostCredential | None:
        return session.exec(select(HostCredential).where(HostCredential.host_id == host_id)).first()


class SSHConnector:
    @staticmethod
    async def _connect(host: Host, credential: HostCredential | None):
        kwargs: dict[str, Any] = {
            "host": host.address,
            "port": host.ssh_port,
            "username": host.username,
            "known_hosts": None,
            "connect_timeout": 3,
        }
        if credential:
            secret = decrypt_secret(credential.encrypted_secret)
            if credential.auth_type == "password":
                kwargs["password"] = secret
            else:
                kwargs["client_keys"] = [asyncssh.import_private_key(secret)]
        return await asyncssh.connect(**kwargs)

    @classmethod
    async def run(
        cls,
        host: Host,
        credential: HostCredential | None,
        command: str,
        timeout_seconds: int = 10,
    ) -> dict[str, Any]:
        try:
            async with await cls._connect(host, credential) as conn:
                result = await asyncio.wait_for(conn.run(command, check=False), timeout=timeout_seconds)
                return {
                    "success": result.exit_status == 0,
                    "exit_code": result.exit_status,
                    "stdout": result.stdout,
                    "stderr": result.stderr,
                }
        except TimeoutError:
            return {
                "success": False,
                "exit_code": 124,
                "stdout": "",
                "stderr": f"Command timed out after {timeout_seconds}s",
            }
        except Exception as exc:
            return {"success": False, "exit_code": 255, "stdout": "", "stderr": str(exc)}


class AgentConnector:
    @staticmethod
    async def call(host: Host, path: str, method: str = "GET", payload: dict[str, Any] | None = None) -> dict[str, Any]:
        if not host.agent_url:
            raise HTTPException(status_code=400, detail="Host has no agent URL")
        timeout = httpx.Timeout(10.0, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(method, f"{host.agent_url}{path}", json=payload)
            response.raise_for_status()
            return response.json()


class PolicyEngine:
    @staticmethod
    def evaluate(action_type: str, parameters: dict[str, Any], host: Host) -> dict[str, Any]:
        blast_radius = {"hosts": 1, "services": 1, "paths": [parameters.get("path")] if parameters.get("path") else []}
        if action_type in {"query_disk", "search_files", "check_port", "query_process", "discover_services", "diagnose_service"}:
            return {
                "allowed": True,
                "risk_level": "L0" if action_type != "diagnose_service" else "L1",
                "approval_required": False,
                "reason": "read-only or diagnostic action",
                "blast_radius": blast_radius,
            }
        if action_type in {"create_linux_user", "delete_linux_user", "restart_service", "kill_process"}:
            return {
                "allowed": True,
                "risk_level": "L3",
                "approval_required": True,
                "reason": "state-changing action requires human approval",
                "blast_radius": blast_radius,
            }
        if action_type in {"delete_path", "modify_security_config", "bulk_permission_change"}:
            return {
                "allowed": False,
                "risk_level": "L4",
                "approval_required": False,
                "reason": "Blocked by safety policy: dangerous filesystem, security config, or bulk permission change",
                "blast_radius": blast_radius,
            }
        return {
            "allowed": True,
            "risk_level": "L2",
            "approval_required": True,
            "reason": "unknown action defaults to approval",
            "blast_radius": blast_radius,
        }


class HostInspector:
    @staticmethod
    async def profile(host: Host, credential: HostCredential | None) -> dict[str, Any]:
        if host.agent_url:
            try:
                response = await AgentConnector.call(host, "/profile")
                return response
            except Exception:
                pass

        command = r"""bash -lc '
            if [ -f /etc/os-release ]; then . /etc/os-release; fi
            os_name="${ID:-unknown}"
            os_version="${VERSION_ID:-unknown}"
            kernel="$(uname -r 2>/dev/null || echo unknown)"
            if command -v dnf >/dev/null 2>&1; then
              package_manager="dnf"
            elif command -v apt >/dev/null 2>&1; then
              package_manager="apt"
            elif command -v yum >/dev/null 2>&1; then
              package_manager="yum"
            else
              package_manager="unknown"
            fi
            if command -v systemctl >/dev/null 2>&1; then systemd=true; else systemd=false; fi
            if command -v docker >/dev/null 2>&1; then docker=true; else docker=false; fi
            if command -v podman >/dev/null 2>&1; then podman=true; else podman=false; fi
            if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then compose=true; else compose=false; fi
            if command -v pm2 >/dev/null 2>&1; then pm2=true; else pm2=false; fi
            if command -v supervisorctl >/dev/null 2>&1; then supervisor=true; else supervisor=false; fi
            if command -v kubectl >/dev/null 2>&1 || command -v kubelet >/dev/null 2>&1; then kubernetes=true; else kubernetes=false; fi
            printf "os_name=%s\n" "$os_name"
            printf "os_version=%s\n" "$os_version"
            printf "kernel=%s\n" "$kernel"
            printf "package_manager=%s\n" "$package_manager"
            printf "systemd=%s\n" "$systemd"
            printf "docker=%s\n" "$docker"
            printf "podman=%s\n" "$podman"
            printf "compose=%s\n" "$compose"
            printf "pm2=%s\n" "$pm2"
            printf "supervisor=%s\n" "$supervisor"
            printf "kubernetes=%s\n" "$kubernetes"
        '"""
        result = await SSHConnector.run(host, credential, command, timeout_seconds=12)
        profile: dict[str, Any] = {"raw": result}
        for line in result["stdout"].splitlines():
            if "=" in line:
                key, value = line.strip().split("=", 1)
                profile[key] = value
        return profile

    @staticmethod
    async def metrics(host: Host, credential: HostCredential | None) -> dict[str, Any]:
        if host.agent_url:
            try:
                return await AgentConnector.call(host, "/metrics")
            except Exception:
                pass

        def _humanize_uptime(seconds: int) -> str:
            seconds = max(int(seconds or 0), 0)
            days, remainder = divmod(seconds, 86400)
            hours, remainder = divmod(remainder, 3600)
            minutes, _ = divmod(remainder, 60)
            parts: list[str] = []
            if days:
                parts.append(f"{days}d")
            if hours or days:
                parts.append(f"{hours}h")
            parts.append(f"{minutes}m")
            return " ".join(parts)

        command = r"""bash -lc '
            set -e
            read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat
            total1=$((user + nice + system + idle + iowait + irq + softirq + steal))
            idle1=$((idle + iowait))
            sleep 0.2
            read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat
            total2=$((user + nice + system + idle + iowait + irq + softirq + steal))
            idle2=$((idle + iowait))
            total_delta=$((total2 - total1))
            idle_delta=$((idle2 - idle1))
            if [ "$total_delta" -gt 0 ]; then
              cpu_percent=$(awk -v total="$total_delta" -v idle="$idle_delta" "BEGIN { printf \"%.2f\", (1 - idle / total) * 100 }")
            else
              cpu_percent="0.00"
            fi
            mem_total_kb=$(awk "/MemTotal/ {print \$2}" /proc/meminfo 2>/dev/null || echo 0)
            mem_available_kb=$(awk "/MemAvailable/ {print \$2}" /proc/meminfo 2>/dev/null || echo 0)
            swap_total_kb=$(awk "/SwapTotal/ {print \$2}" /proc/meminfo 2>/dev/null || echo 0)
            swap_free_kb=$(awk "/SwapFree/ {print \$2}" /proc/meminfo 2>/dev/null || echo 0)
            if [ "$mem_total_kb" -gt 0 ]; then
              memory_percent=$(awk -v total="$mem_total_kb" -v available="$mem_available_kb" "BEGIN { printf \"%.2f\", (1 - available / total) * 100 }")
            else
              memory_percent="0.00"
            fi
            if [ "$swap_total_kb" -gt 0 ]; then
              swap_percent=$(awk -v total="$swap_total_kb" -v free="$swap_free_kb" "BEGIN { printf \"%.2f\", (1 - free / total) * 100 }")
            else
              swap_percent="0.00"
            fi
            disk_root=$(df -P / | awk "NR==2 {print \$5}")
            load=$(uptime | sed "s/.*load averages*: //; s/.*load average: //")
            uptime_seconds=$(awk "{print int(\$1)}" /proc/uptime 2>/dev/null || echo 0)
            printf "cpu_percent=%s\n" "$cpu_percent"
            printf "load=%s\n" "$load"
            printf "uptime_seconds=%s\n" "$uptime_seconds"
            printf "mem_total_kb=%s\n" "$mem_total_kb"
            printf "mem_available_kb=%s\n" "$mem_available_kb"
            printf "memory_percent=%s\n" "$memory_percent"
            printf "swap_total_kb=%s\n" "$swap_total_kb"
            printf "swap_free_kb=%s\n" "$swap_free_kb"
            printf "swap_percent=%s\n" "$swap_percent"
            printf "disk_root=%s\n" "$disk_root"
            echo "__TOP__"
            ps -eo pid=,user=,comm=,%cpu=,%mem= --sort=-%cpu | head -n 7
            echo "__FS__"
            df -Pk | tail -n +2 | head -n 12
        '"""
        result = await SSHConnector.run(host, credential, command, timeout_seconds=8)
        metrics: dict[str, Any] = {"raw": result}
        top_processes: list[dict[str, Any]] = []
        filesystems: list[dict[str, Any]] = []
        section = "meta"
        for line in result["stdout"].splitlines():
            if line.strip() == "__TOP__":
                section = "top"
                continue
            if line.strip() == "__FS__":
                section = "filesystem"
                continue
            if section == "top":
                if not line.strip() or line.strip().startswith("PID"):
                    continue
                parts = line.split()
                if len(parts) >= 5:
                    top_processes.append(
                        {
                            "pid": parts[0],
                            "user": parts[1],
                            "command": parts[2],
                            "cpu_percent": parts[3],
                            "mem_percent": parts[4],
                        }
                    )
                continue
            if section == "filesystem":
                parts = line.split()
                if len(parts) >= 6:
                    size_kb = int(parts[1] or 0)
                    used_kb = int(parts[2] or 0)
                    available_kb = int(parts[3] or 0)
                    filesystems.append(
                        {
                            "filesystem": parts[0],
                            "mount": " ".join(parts[5:]),
                            "size_kb": size_kb,
                            "used_kb": used_kb,
                            "available_kb": available_kb,
                            "size_bytes": size_kb * 1024,
                            "used_bytes": used_kb * 1024,
                            "available_bytes": available_kb * 1024,
                            "percent": float(str(parts[4]).rstrip("%") or 0),
                        }
                    )
                continue
            if "=" in line:
                key, value = line.strip().split("=", 1)
                metrics[key] = value
        memory_percent = float(metrics.get("memory_percent") or 0)
        memory_total_kb = int(metrics.get("mem_total_kb") or 0)
        memory_available_kb = int(metrics.get("mem_available_kb") or 0)
        swap_total_kb = int(metrics.get("swap_total_kb") or 0)
        swap_free_kb = int(metrics.get("swap_free_kb") or 0)
        uptime_seconds = int(metrics.get("uptime_seconds") or 0)
        disk_percent = str(metrics.get("disk_root") or "0").strip().rstrip("%")
        cpu_percent = float(metrics.get("cpu_percent") or 0)
        load_parts = [part.strip() for part in str(metrics.get("load") or "").split(",") if part.strip()]
        metrics["cpu_percent"] = cpu_percent
        metrics["uptime_seconds"] = uptime_seconds
        metrics["uptime_human"] = _humanize_uptime(uptime_seconds)
        metrics["load_average"] = [
            round(float(part), 2)
            for part in load_parts[:3]
            if part.replace(".", "", 1).isdigit()
        ]
        metrics["memory"] = {
            "total_kb": memory_total_kb,
            "available_kb": memory_available_kb,
            "used_kb": max(memory_total_kb - memory_available_kb, 0),
            "total_bytes": memory_total_kb * 1024,
            "available_bytes": memory_available_kb * 1024,
            "used_bytes": max(memory_total_kb - memory_available_kb, 0) * 1024,
            "percent": memory_percent,
        }
        metrics["swap"] = {
            "total_kb": swap_total_kb,
            "free_kb": swap_free_kb,
            "used_kb": max(swap_total_kb - swap_free_kb, 0),
            "total_bytes": swap_total_kb * 1024,
            "free_bytes": swap_free_kb * 1024,
            "used_bytes": max(swap_total_kb - swap_free_kb, 0) * 1024,
            "percent": float(metrics.get("swap_percent") or 0),
        }
        metrics["disk"] = {
            "percent": float(disk_percent or 0),
        }
        metrics["filesystems"] = filesystems
        metrics["top_processes"] = top_processes
        return metrics

    @staticmethod
    async def discover_services(host: Host, credential: HostCredential | None) -> list[dict[str, Any]]:
        if host.agent_url:
            try:
                response = await AgentConnector.call(host, "/discover")
                return response.get("services", [])
            except Exception:
                pass

        services: list[dict[str, Any]] = []
        systemd_cmd = "systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null | head -n 40"
        docker_inspect_cmd = "docker ps -q | head -n 20 | xargs -r docker inspect --format '{{json .}}' 2>/dev/null || true"
        podman_cmd = "podman ps --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Ports}}' 2>/dev/null || true"
        pm2_cmd = "pm2 jlist 2>/dev/null || true"
        supervisor_cmd = "supervisorctl status all 2>/dev/null || supervisorctl status 2>/dev/null || true"
        kubernetes_cmd = "kubectl get pods -A -o json --request-timeout=5s 2>/dev/null || true"
        port_cmd = "ss -ltnp 2>/dev/null | tail -n +2 | head -n 40 || true"

        systemd_result = await SSHConnector.run(host, credential, systemd_cmd, timeout_seconds=8)
        for line in systemd_result["stdout"].splitlines():
            parts = line.split()
            if len(parts) >= 4:
                services.append(
                    _annotate_service(
                        {
                        "service_key": f"systemd:{parts[0]}",
                        "name": parts[0],
                        "service_type": "systemd",
                        "runtime_type": "systemd",
                        "status": parts[3],
                        "ports": [],
                        "discovery_source": ["systemd"],
                        "evidence_json": {"raw": line},
                        "confidence": 0.95,
                        }
                    )
                )

        docker_result = await SSHConnector.run(host, credential, docker_inspect_cmd, timeout_seconds=10)
        compose_groups: dict[tuple[str, str], dict[str, Any]] = {}
        for line in docker_result["stdout"].splitlines():
            text = line.strip()
            if not text.startswith("{"):
                continue
            try:
                item = json.loads(text)
            except Exception:
                continue
            name = str(item.get("Name") or "").lstrip("/") or "container"
            config = item.get("Config") or {}
            labels = config.get("Labels") or {}
            state = (item.get("State") or {}).get("Status") or "unknown"
            ports = _extract_ports_from_docker_inspect(item)
            image = config.get("Image")
            compose_project = labels.get("com.docker.compose.project")
            compose_service = labels.get("com.docker.compose.service")
            if compose_project and compose_service:
                group_key = (compose_project, compose_service)
                existing = compose_groups.get(group_key)
                if not existing:
                    existing = _annotate_service({
                        "service_key": f"compose:{compose_project}:{compose_service}",
                        "name": f"{compose_project}/{compose_service}",
                        "service_type": "compose-service",
                        "runtime_type": "docker-compose",
                        "status": state,
                        "ports": [],
                        "process_ref": None,
                        "config_path": labels.get("com.docker.compose.project.config_files"),
                        "log_hint": labels.get("com.docker.compose.project.working_dir"),
                        "discovery_source": ["docker", "docker-compose"],
                        "evidence_json": {
                            "project": compose_project,
                            "service": compose_service,
                            "working_dir": labels.get("com.docker.compose.project.working_dir"),
                            "config_files": labels.get("com.docker.compose.project.config_files"),
                            "labels": labels,
                            "containers": [],
                        },
                        "confidence": 0.94,
                    })
                    compose_groups[group_key] = existing
                existing["ports"] = sorted(set(existing["ports"]) | set(ports))
                if state == "running":
                    existing["status"] = "running"
                existing["evidence_json"]["containers"].append(
                    {
                        "name": name,
                        "image": image,
                        "status": state,
                        "ports": ports,
                    }
                )
                continue

            services.append(
                _annotate_service({
                    "service_key": f"docker:{name}",
                    "name": name,
                    "service_type": "container",
                    "runtime_type": "docker",
                    "status": state,
                    "ports": ports,
                    "discovery_source": ["docker"],
                    "evidence_json": {"name": name, "image": image, "labels": labels},
                    "confidence": 0.9,
                })
            )

        services.extend(compose_groups.values())

        podman_result = await SSHConnector.run(host, credential, podman_cmd, timeout_seconds=8)
        for line in podman_result["stdout"].splitlines():
            if not line.strip():
                continue
            name, image, state, ports = (line.split("|") + ["", "", "", ""])[:4]
            port_values = _extract_ports_from_text(ports)
            services.append(
                _annotate_service({
                    "service_key": f"podman:{name}",
                    "name": name,
                    "service_type": "container",
                    "runtime_type": "podman",
                    "status": state or "unknown",
                    "ports": port_values,
                    "discovery_source": ["podman"],
                    "evidence_json": {"raw": line, "image": image},
                    "confidence": 0.88,
                })
            )

        pm2_result = await SSHConnector.run(host, credential, pm2_cmd, timeout_seconds=8)
        if pm2_result["success"] and pm2_result["stdout"].strip().startswith("["):
            try:
                pm2_apps = json.loads(pm2_result["stdout"])
                for item in pm2_apps[:20]:
                    pm2_env = item.get("pm2_env", {}) if isinstance(item.get("pm2_env"), dict) else {}
                    name = item.get("name") or pm2_env.get("name") or "pm2-app"
                    services.append(
                        _annotate_service({
                            "service_key": f"pm2:{pm2_env.get('pm_id', name)}",
                            "name": name,
                            "service_type": "application",
                            "runtime_type": "pm2",
                            "status": pm2_env.get("status", "unknown"),
                            "ports": _extract_pm2_ports(pm2_env),
                            "process_ref": str(item.get("pid") or pm2_env.get("pm_id") or ""),
                            "config_path": pm2_env.get("pm_exec_path") or pm2_env.get("cwd"),
                            "log_hint": pm2_env.get("pm_out_log_path") or pm2_env.get("pm_log_path"),
                            "discovery_source": ["pm2"],
                            "evidence_json": {
                                "pm2_env": {
                                    "pm_id": pm2_env.get("pm_id"),
                                    "status": pm2_env.get("status"),
                                    "cwd": pm2_env.get("cwd"),
                                    "exec_path": pm2_env.get("pm_exec_path"),
                                    "namespace": pm2_env.get("namespace"),
                                    "instances": pm2_env.get("instances"),
                                },
                                "monit": item.get("monit"),
                            },
                            "confidence": 0.9,
                        })
                    )
            except Exception:
                pass

        supervisor_result = await SSHConnector.run(host, credential, supervisor_cmd, timeout_seconds=8)
        for line in supervisor_result["stdout"].splitlines():
            parts = line.split()
            if len(parts) < 2:
                continue
            name = parts[0]
            status = parts[1].lower()
            pid_match = re.search(r"pid\s+(\d+)", line)
            services.append(
                _annotate_service({
                    "service_key": f"supervisor:{name}",
                    "name": name,
                    "service_type": "program",
                    "runtime_type": "supervisor",
                    "status": status,
                    "ports": [],
                    "process_ref": pid_match.group(1) if pid_match else None,
                    "discovery_source": ["supervisor"],
                    "evidence_json": {"raw": line},
                    "confidence": 0.89,
                })
            )

        kubernetes_result = await SSHConnector.run(host, credential, kubernetes_cmd, timeout_seconds=8)
        text = kubernetes_result["stdout"].strip()
        if kubernetes_result["success"] and text.startswith("{"):
            try:
                payload = json.loads(text)
                for item in (payload.get("items") or [])[:30]:
                    metadata = item.get("metadata") or {}
                    spec = item.get("spec") or {}
                    status_info = item.get("status") or {}
                    namespace = metadata.get("namespace") or "default"
                    pod_name = metadata.get("name") or "pod"
                    labels = metadata.get("labels") or {}
                    owner_refs = metadata.get("ownerReferences") or []
                    owner = owner_refs[0] if owner_refs else {}
                    container_specs = spec.get("containers") or []
                    images = [container.get("image") for container in container_specs if container.get("image")]
                    ports: set[int] = set()
                    for container in container_specs:
                        for port in container.get("ports") or []:
                            value = port.get("containerPort")
                            if isinstance(value, int):
                                ports.add(value)
                    services.append(
                        _annotate_service({
                            "service_key": f"k8s:{namespace}:{pod_name}",
                            "name": f"{namespace}/{pod_name}",
                            "service_type": str(owner.get("kind") or "pod").lower(),
                            "runtime_type": "kubernetes",
                            "status": str(status_info.get("phase") or "unknown").lower(),
                            "ports": sorted(ports),
                            "process_ref": spec.get("nodeName"),
                            "config_path": namespace,
                            "log_hint": f"kubectl logs -n {namespace} {pod_name}",
                            "discovery_source": ["kubernetes"],
                            "evidence_json": {
                                "namespace": namespace,
                                "pod": pod_name,
                                "owner": owner,
                                "labels": labels,
                                "images": images,
                                "node_name": spec.get("nodeName"),
                            },
                            "confidence": 0.92,
                        })
                    )
            except Exception:
                pass

        port_result = await SSHConnector.run(host, credential, port_cmd, timeout_seconds=8)
        seen_listener_keys: set[str] = set()
        for line in port_result["stdout"].splitlines():
            ports = _extract_ports_from_text(line)
            if ports:
                listener_key = f"port:{ports[0]}"
                if listener_key in seen_listener_keys:
                    continue
                seen_listener_keys.add(listener_key)
                services.append(
                    _annotate_service({
                        "service_key": listener_key,
                        "name": f"port-{ports[0]}",
                        "service_type": "listener",
                        "runtime_type": "process",
                        "status": "listening",
                        "ports": ports,
                        "discovery_source": ["socket-scan"],
                        "evidence_json": {"raw": line},
                        "confidence": 0.65,
                    })
                )
        return services


class ServiceSync:
    @staticmethod
    def sync(session: Session, host: Host, services: list[dict[str, Any]]) -> list[Service]:
        session.exec(delete(Service).where(Service.host_id == host.id))
        session.commit()
        stored: list[Service] = []
        for item in services:
            service = Service(
                host_id=host.id,
                service_key=item["service_key"],
                name=item["name"],
                service_type=item["service_type"],
                runtime_type=item["runtime_type"],
                status=item.get("status", "unknown"),
                ports=item.get("ports", []),
                process_ref=item.get("process_ref"),
                config_path=item.get("config_path"),
                log_hint=item.get("log_hint"),
                discovery_source=item.get("discovery_source", []),
                evidence_json=item.get("evidence_json", {}),
                confidence=float(item.get("confidence", 1.0)),
                last_seen_at=now(),
            )
            session.add(service)
            stored.append(service)
        session.commit()
        return stored


@dataclass
class IntentPlan:
    task_type: str
    action_type: str
    title: str
    goal: str
    criteria: list[dict[str, Any]]
    parameters: dict[str, Any]


class ClaudePlanner:
    @staticmethod
    async def maybe_summarize(prompt: str, context: dict[str, Any], session: Session) -> dict[str, Any] | None:
        if not settings.claude_enabled:
            return None
        try:
            system_prompt = (
                "You are an operations planner. Convert the user request into JSON with "
                "keys summary, risk_hint, target_guess. Return concise JSON only."
            )
            user_content = (
                f"User request: {prompt}\n"
                f"Context: {json.dumps(context, ensure_ascii=False)}"
            )
            text = await registry.chat_completion(
                model=settings.model,
                messages=[
                    LLMMessage(role="system", content=system_prompt),
                    LLMMessage(role="user", content=user_content),
                ],
                timeout=8,
            )
            return {"raw": text}
        except Exception:
            return None


class GoalDrivenOrchestrator:
    def __init__(self, session: Session, user: User):
        self.session = session
        self.user = user

    def _build_plan(self, prompt: str, selected_hosts: list[int]) -> IntentPlan:
        lowered = prompt.lower()
        username_match = re.search(r"(?:用户|账号|user)\s*[:：]?\s*([a-zA-Z][\w-]{1,30})", prompt)
        service_match = re.search(r"(?:服务|service)\s*[:：]?\s*([a-zA-Z0-9._-]+)", prompt)
        port_match = re.search(r"(\d{2,5})\s*(?:端口|port)", prompt)
        if "磁盘" in prompt or "disk" in lowered:
            return IntentPlan(
                task_type="query",
                action_type="query_disk",
                title="查询磁盘使用情况",
                goal=f"在指定主机上获取磁盘使用情况: {prompt}",
                criteria=[{"type": "has_disk_result"}],
                parameters={},
            )
        if "端口" in prompt or "port" in lowered:
            return IntentPlan(
                task_type="query",
                action_type="check_port",
                title="查询端口占用",
                goal=f"定位端口占用进程: {prompt}",
                criteria=[{"type": "has_port_result"}],
                parameters={"port": int(port_match.group(1)) if port_match else None},
            )
        if "进程" in prompt or "process" in lowered:
            return IntentPlan(
                task_type="query",
                action_type="query_process",
                title="查询进程状态",
                goal=f"获取指定主机上的进程状态: {prompt}",
                criteria=[{"type": "has_process_result"}],
                parameters={},
            )
        if "创建" in prompt and ("用户" in prompt or "user" in lowered):
            return IntentPlan(
                task_type="change",
                action_type="create_linux_user",
                title="创建 Linux 用户",
                goal=f"在目标主机上创建用户: {prompt}",
                criteria=[{"type": "user_exists", "username": username_match.group(1) if username_match else None}],
                parameters={"username": username_match.group(1) if username_match else None},
            )
        if ("删除" in prompt or "remove" in lowered or "delete" in lowered) and ("用户" in prompt or "user" in lowered):
            return IntentPlan(
                task_type="change",
                action_type="delete_linux_user",
                title="删除 Linux 用户",
                goal=f"在目标主机上删除用户: {prompt}",
                criteria=[{"type": "user_absent", "username": username_match.group(1) if username_match else None}],
                parameters={"username": username_match.group(1) if username_match else None},
            )
        return IntentPlan(
            task_type="diagnose",
            action_type="diagnose_service",
            title="服务排障",
            goal=f"对服务问题执行 goal-driven 排障: {prompt}",
            criteria=[{"type": "diagnosis_ready"}, {"type": "approval_if_action_required"}],
            parameters={"service_name": service_match.group(1) if service_match else None},
        )

    async def _execute_action(self, host: Host, credential: HostCredential | None, action_type: str, parameters: dict[str, Any]) -> dict[str, Any]:
        if host.agent_url and action_type not in {"query_process", "check_port"}:
            try:
                return await AgentConnector.call(
                    host,
                    "/execute",
                    method="POST",
                    payload={"action_type": action_type, "parameters": parameters, "dry_run": False},
                )
            except Exception:
                pass

        if action_type == "diagnose_service":
            service = parameters.get("service_name") or "sshd"
            command = (
                f"systemctl status {service} --no-pager || true; "
                f"journalctl -u {service} -n 40 --no-pager || true; "
                "ss -ltnp | tail -n +1 || true"
            )
        elif action_type == "query_disk":
            command = "df -h"
        elif action_type == "check_port":
            command = f"ss -ltnp | grep ':{parameters.get('port')}' || true"
        elif action_type == "query_process":
            command = "ps aux | head -n 20"
        elif action_type == "create_linux_user":
            command = f"sudo useradd -m {parameters['username']}"
        elif action_type == "delete_linux_user":
            command = f"sudo userdel -r {parameters['username']}"
        else:
            command = "echo unsupported action"
        return await SSHConnector.run(host, credential, command, timeout_seconds=8)

    async def _verify(self, host: Host, credential: HostCredential | None, action_type: str, parameters: dict[str, Any]) -> dict[str, Any]:
        username = parameters.get("username")
        if action_type == "create_linux_user" and username:
            return await SSHConnector.run(host, credential, f"getent passwd {username}", timeout_seconds=8)
        if action_type == "delete_linux_user" and username:
            return await SSHConnector.run(host, credential, f"getent passwd {username} || true", timeout_seconds=8)
        if action_type == "query_disk":
            return await SSHConnector.run(host, credential, "df -h", timeout_seconds=8)
        if action_type == "check_port" and parameters.get("port"):
            return await SSHConnector.run(host, credential, f"ss -ltnp | grep ':{parameters['port']}' || true", timeout_seconds=8)
        return {"success": True, "stdout": "No extra verification required", "stderr": "", "exit_code": 0}

    async def execute(self, prompt: str, session_id: str, selected_host_ids: list[int], auto_approve: bool) -> Task:
        if not selected_host_ids:
            raise HTTPException(status_code=400, detail="At least one host must be selected")
        host = HostRepository.get_host(self.session, selected_host_ids[0])
        credential = HostRepository.get_credential(self.session, host.id)
        plan = self._build_plan(prompt, selected_host_ids)
        policy = PolicyEngine.evaluate(plan.action_type, plan.parameters, host)
        claude_hint = await ClaudePlanner.maybe_summarize(
            prompt,
            {
                "selected_hosts": selected_host_ids,
                "host_name": host.name,
                "environment": host.environment,
                "action_type": plan.action_type,
            },
            self.session,
        )

        task = Task(
            session_id=session_id,
            user_id=self.user.id,
            title=plan.title,
            prompt=prompt,
            task_type=plan.task_type,
            goal=plan.goal,
            criteria_json=plan.criteria,
            target_hosts=selected_host_ids,
            risk_level=policy["risk_level"],
            status="running",
            plan_json={
                "action_type": plan.action_type,
                "parameters": plan.parameters,
                "policy": policy,
                "claude_hint": claude_hint,
            },
        )
        self.session.add(task)
        self.session.commit()
        self.session.refresh(task)

        for step_type, title, payload in [
            ("observe", "收集主机与服务上下文", {"host_id": host.id}),
            ("analyze", "生成执行计划", {"prompt": prompt}),
        ]:
            step = TaskStep(task_id=task.id, step_type=step_type, title=title, status="completed", input_json=payload, output_json=payload)
            self.session.add(step)
        self.session.commit()
        upsert_audit(self.session, actor_id=self.user.id, task_id=task.id, host_id=host.id, event_type="task_created", payload=task.plan_json)

        if not policy.get("allowed", False):
            task.status = "failed"
            task.result_json = {"reason": policy.get("reason", "Blocked")}
            task.updated_at = now()
            self.session.add(task)
            self.session.commit()
            upsert_audit(self.session, actor_id=self.user.id, task_id=task.id, host_id=host.id, event_type="task_blocked", payload=task.result_json)
            return task

        if policy.get("approval_required") and not auto_approve:
            approval = Approval(
                task_id=task.id,
                requester_id=self.user.id,
                status="pending",
                action_payload={"action_type": plan.action_type, "parameters": plan.parameters, "host_id": host.id},
            )
            self.session.add(approval)
            task.status = "waiting_approval"
            task.approval_required = True
            self.session.add(task)
            self.session.commit()
            upsert_audit(self.session, actor_id=self.user.id, task_id=task.id, host_id=host.id, event_type="approval_requested", payload=approval.action_payload)
            return task

        return await self._run_act_and_verify(task, host, credential, plan.action_type, plan.parameters)

    async def _run_act_and_verify(
        self,
        task: Task,
        host: Host,
        credential: HostCredential | None,
        action_type: str,
        parameters: dict[str, Any],
    ) -> Task:
        act_result = await self._execute_action(host, credential, action_type, parameters)
        self.session.add(
            TaskStep(
                task_id=task.id,
                step_type="act",
                title="执行主动作",
                status="completed" if act_result.get("success") else "failed",
                input_json={"action_type": action_type, "parameters": parameters},
                output_json=jsonable(act_result),
                retryable=bool(act_result.get("retryable")),
            )
        )
        verify_result = await self._verify(host, credential, action_type, parameters)
        self.session.add(
            TaskStep(
                task_id=task.id,
                step_type="verify",
                title="校验成功标准",
                status="completed",
                input_json={"criteria": task.criteria_json},
                output_json=jsonable(verify_result),
                retryable=False,
            )
        )
        task.status = "succeeded" if act_result.get("success", False) else "failed"
        task.result_json = {
            "action_result": jsonable(act_result),
            "verification_result": jsonable(verify_result),
        }
        task.updated_at = now()
        self.session.add(task)
        self.session.commit()
        upsert_audit(self.session, actor_id=self.user.id, task_id=task.id, host_id=host.id, event_type="task_finished", payload=task.result_json)
        return task

    async def resume_after_approval(self, approval: Approval, approver: User, approved: bool, reason: str | None) -> Task:
        task = self.session.get(Task, approval.task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        approval.approver_id = approver.id
        approval.status = "approved" if approved else "rejected"
        approval.decision_reason = reason
        approval.decided_at = now()
        self.session.add(approval)
        if not approved:
            task.status = "failed"
            task.result_json = {"reason": reason or "Approval rejected"}
            self.session.add(task)
            self.session.commit()
            upsert_audit(self.session, actor_id=approver.id, task_id=task.id, host_id=approval.action_payload.get("host_id"), event_type="approval_rejected", payload={"reason": reason})
            return task
        host = HostRepository.get_host(self.session, approval.action_payload["host_id"])
        credential = HostRepository.get_credential(self.session, host.id)
        task.status = "running"
        self.session.add(task)
        self.session.commit()
        upsert_audit(self.session, actor_id=approver.id, task_id=task.id, host_id=host.id, event_type="approval_granted", payload={"reason": reason})
        return await self._run_act_and_verify(task, host, credential, approval.action_payload["action_type"], approval.action_payload["parameters"])


class DashboardService:
    @staticmethod
    def overview(session: Session) -> dict[str, Any]:
        from .monitoring import MonitoringCoreService

        hosts = list(session.exec(select(Host)).all())
        services = list(session.exec(select(Service)).all())
        tasks = list(session.exec(select(Task).order_by(Task.id.desc()).limit(10)).all())
        approvals = list(session.exec(select(Approval).order_by(Approval.id.desc()).limit(10)).all())
        host_overview = []
        for host in hosts[:20]:
            summary = MonitoringCoreService.host_summary(session, host)
            host_overview.append(
                {
                    **serialize_model(host),
                    "monitoring_summary": summary,
                }
            )
        return {
            "stats": {
                "hosts": len(hosts),
                "online_hosts": len([host for host in hosts if host.status in {"online", "registered"}]),
                "services": len(services),
                "pending_approvals": len([approval for approval in approvals if approval.status == "pending"]),
                "recent_tasks": len(tasks),
            },
            "hosts": host_overview,
            "services": [serialize_model(service) for service in services[:20]],
            "tasks": [serialize_model(task) for task in tasks],
            "approvals": [serialize_model(approval) for approval in approvals],
        }


