from __future__ import annotations

import json
import os
import re
import socket
import subprocess
from datetime import datetime, timezone
from typing import Any

import httpx
import psutil
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def run(command: str) -> dict[str, Any]:
    process = subprocess.run(command, shell=True, capture_output=True, text=True)
    return {
        "success": process.returncode == 0,
        "exit_code": process.returncode,
        "stdout": process.stdout,
        "stderr": process.stderr,
    }


def extract_ports_from_text(value: str) -> list[int]:
    return sorted({int(match) for match in re.findall(r":(\d+)(?:->|\s)", value or "")})


def extract_ports_from_docker_inspect(item: dict[str, Any]) -> list[int]:
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


def extract_pm2_ports(pm2_env: dict[str, Any]) -> list[int]:
    env = pm2_env.get("env") if isinstance(pm2_env.get("env"), dict) else {}
    ports: set[int] = set()
    for key, value in env.items():
        if "PORT" in str(key).upper():
            text = str(value).strip()
            if text.isdigit():
                ports.add(int(text))
    return sorted(ports)


def profile() -> dict[str, Any]:
    os_name = "linux"
    os_version = "unknown"
    try:
        with open("/etc/os-release", "r", encoding="utf-8") as handle:
            data = {}
            for line in handle:
                if "=" in line:
                    key, value = line.strip().split("=", 1)
                    data[key] = value.strip('"')
            os_name = data.get("ID", os_name)
            os_version = data.get("VERSION_ID", os_version)
    except FileNotFoundError:
        pass
    package_manager = "unknown"
    for candidate in ["dnf", "apt", "yum"]:
        if run(f"command -v {candidate}")["success"]:
            package_manager = candidate
            break
    return {
        "hostname": socket.gethostname(),
        "os_name": os_name,
        "os_version": os_version,
        "kernel": run("uname -r")["stdout"].strip(),
        "package_manager": package_manager,
        "docker": run("command -v docker")["success"],
        "podman": run("command -v podman")["success"],
        "compose": run("docker compose version")["success"],
        "pm2": run("command -v pm2")["success"],
        "supervisor": run("command -v supervisorctl")["success"],
        "collected_at": now(),
    }


def metrics() -> dict[str, Any]:
    memory = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk = psutil.disk_usage("/")
    top_processes: list[dict[str, Any]] = []
    for process in sorted(psutil.process_iter(["pid", "username", "name", "cpu_percent", "memory_percent"]), key=lambda item: item.info.get("cpu_percent") or 0, reverse=True)[:6]:
        top_processes.append(
            {
                "pid": process.info.get("pid"),
                "user": process.info.get("username"),
                "command": process.info.get("name"),
                "cpu_percent": process.info.get("cpu_percent"),
                "mem_percent": round(process.info.get("memory_percent") or 0, 2),
            }
        )
    filesystems: list[dict[str, Any]] = []
    seen_mounts: set[str] = set()
    for partition in psutil.disk_partitions(all=False):
        mountpoint = partition.mountpoint
        if mountpoint in seen_mounts:
            continue
        seen_mounts.add(mountpoint)
        try:
            usage = psutil.disk_usage(mountpoint)
        except Exception:
            continue
        filesystems.append(
            {
                "filesystem": partition.device or partition.fstype or mountpoint,
                "mount": mountpoint,
                "size_bytes": usage.total,
                "used_bytes": usage.used,
                "available_bytes": usage.free,
                "size_kb": int(usage.total / 1024),
                "used_kb": int(usage.used / 1024),
                "available_kb": int(usage.free / 1024),
                "percent": usage.percent,
            }
        )
        if len(filesystems) >= 12:
            break
    uptime_seconds = max(int(datetime.now(timezone.utc).timestamp() - psutil.boot_time()), 0)
    return {
        "cpu_percent": psutil.cpu_percent(interval=0.2),
        "load_average": list(os.getloadavg()),
        "uptime_seconds": uptime_seconds,
        "memory": {
            "total": memory.total,
            "used": memory.used,
            "available": memory.available,
            "total_bytes": memory.total,
            "used_bytes": memory.used,
            "available_bytes": memory.available,
            "percent": memory.percent,
        },
        "swap": {
            "total": swap.total,
            "used": swap.used,
            "free": swap.free,
            "total_bytes": swap.total,
            "used_bytes": swap.used,
            "free_bytes": swap.free,
            "percent": swap.percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
            "percent": disk.percent,
        },
        "filesystems": filesystems,
        "top_processes": top_processes,
        "collected_at": now(),
    }


def discover_services() -> list[dict[str, Any]]:
    services: list[dict[str, Any]] = []
    for line in run("systemctl list-units --type=service --all --no-pager --no-legend | head -n 40")["stdout"].splitlines():
        parts = line.split()
        if len(parts) >= 4:
            services.append(
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
    compose_groups: dict[tuple[str, str], dict[str, Any]] = {}
    for line in run("docker ps -q | head -n 20 | xargs -r docker inspect --format '{{json .}}' 2>/dev/null || true")["stdout"].splitlines():
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
        ports = extract_ports_from_docker_inspect(item)
        image = config.get("Image")
        compose_project = labels.get("com.docker.compose.project")
        compose_service = labels.get("com.docker.compose.service")
        if compose_project and compose_service:
            group_key = (compose_project, compose_service)
            existing = compose_groups.get(group_key)
            if not existing:
                existing = {
                    "service_key": f"compose:{compose_project}:{compose_service}",
                    "name": f"{compose_project}/{compose_service}",
                    "service_type": "compose-service",
                    "runtime_type": "docker-compose",
                    "status": state,
                    "ports": [],
                    "config_path": labels.get("com.docker.compose.project.config_files"),
                    "log_hint": labels.get("com.docker.compose.project.working_dir"),
                    "discovery_source": ["docker", "docker-compose"],
                    "evidence_json": {
                        "project": compose_project,
                        "service": compose_service,
                        "working_dir": labels.get("com.docker.compose.project.working_dir"),
                        "config_files": labels.get("com.docker.compose.project.config_files"),
                        "containers": [],
                    },
                    "confidence": 0.94,
                }
                compose_groups[group_key] = existing
            existing["ports"] = sorted(set(existing["ports"]) | set(ports))
            if state == "running":
                existing["status"] = "running"
            existing["evidence_json"]["containers"].append(
                {"name": name, "image": image, "status": state, "ports": ports}
            )
            continue
        services.append(
            {
                "service_key": f"docker:{name}",
                "name": name,
                "service_type": "container",
                "runtime_type": "docker",
                "status": state,
                "ports": ports,
                "discovery_source": ["docker"],
                "evidence_json": {"name": name, "image": image, "labels": labels},
                "confidence": 0.9,
            }
        )
    services.extend(compose_groups.values())
    pm2_raw = run("pm2 jlist 2>/dev/null || true")["stdout"]
    if pm2_raw.strip().startswith("["):
        try:
            for item in json.loads(pm2_raw)[:20]:
                pm2_env = item.get("pm2_env", {}) if isinstance(item.get("pm2_env"), dict) else {}
                name = item.get("name") or pm2_env.get("name") or "pm2-app"
                services.append(
                    {
                        "service_key": f"pm2:{pm2_env.get('pm_id', name)}",
                        "name": name,
                        "service_type": "application",
                        "runtime_type": "pm2",
                        "status": pm2_env.get("status", "unknown"),
                        "ports": extract_pm2_ports(pm2_env),
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
                    }
                )
        except Exception:
            pass
    for line in run("supervisorctl status all 2>/dev/null || supervisorctl status 2>/dev/null || true")["stdout"].splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        pid_match = re.search(r"pid\s+(\d+)", line)
        services.append(
            {
                "service_key": f"supervisor:{parts[0]}",
                "name": parts[0],
                "service_type": "program",
                "runtime_type": "supervisor",
                "status": parts[1].lower(),
                "ports": [],
                "process_ref": pid_match.group(1) if pid_match else None,
                "discovery_source": ["supervisor"],
                "evidence_json": {"raw": line},
                "confidence": 0.89,
            }
        )
    return services


class RegisterPayload(BaseModel):
    registration_token: str
    control_plane_url: str
    identity: str
    version: str = "0.1.0"
    capabilities: dict[str, Any] = Field(default_factory=dict)


class ExecutionPayload(BaseModel):
    action_type: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = False


app = FastAPI(title="XFusion Node Agent")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/profile")
def profile_endpoint() -> dict[str, Any]:
    return profile()


@app.get("/metrics")
def metrics_endpoint() -> dict[str, Any]:
    return metrics()


@app.get("/discover")
def discover_endpoint() -> dict[str, Any]:
    return {"services": discover_services()}


@app.post("/register")
async def register(payload: RegisterPayload) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            f"{payload.control_plane_url}/api/agents/register",
            json={
                "registration_token": payload.registration_token,
                "identity": payload.identity,
                "version": payload.version,
                "capabilities": payload.capabilities or {"profile": True, "metrics": True, "discover": True},
            },
        )
        response.raise_for_status()
        return response.json()


@app.post("/heartbeat")
async def heartbeat(payload: RegisterPayload) -> dict[str, Any]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.post(
            f"{payload.control_plane_url}/api/agents/heartbeat",
            json={
                "identity": payload.identity,
                "metrics": metrics(),
                "profile": profile(),
                "services": discover_services(),
            },
        )
        response.raise_for_status()
        return response.json()


@app.post("/execute")
def execute(payload: ExecutionPayload) -> dict[str, Any]:
    action = payload.action_type
    params = payload.parameters
    if action == "query_disk":
        return run("df -h")
    if action == "search_files":
        query = str(params.get("query") or "").replace("'", "")
        path = str(params.get("path") or "/etc")
        if not path.startswith("/"):
            path = f"/{path}"
        if query:
            return run(f"find '{path}' -maxdepth 6 \\( -iname '*{query}*' -o -path '*{query}*' \\) -print 2>/dev/null | head -n 60")
        return run(f"find '{path}' -maxdepth 3 -print 2>/dev/null | head -n 60")
    if action == "query_process":
        process_name = params.get("process_name")
        if process_name:
            return run(f"ps aux | grep -i '{process_name}' | grep -v grep | head -n 25 || true")
        return run("ps -eo pid,user,comm,%cpu,%mem --sort=-%cpu | head -n 25")
    if action == "check_port":
        port = params.get("port")
        return run(f"ss -ltnp | grep ':{port}' || true")
    if action == "create_linux_user":
        return run(f"sudo useradd -m {params['username']}")
    if action == "delete_linux_user":
        return run(f"sudo userdel -r {params['username']}")
    if action == "diagnose_service":
        service = params.get("service_name") or "sshd"
        return run(f"systemctl status {service} --no-pager || true; systemctl is-active {service} || true; journalctl -u {service} -n 60 --no-pager || true; ss -ltnp | tail -n +1 || true")
    if action == "restart_service":
        service = params.get("service_name") or "sshd"
        return run(f"sudo systemctl restart {service} && systemctl is-active {service}")
    if action == "kill_process":
        pid = params.get("pid")
        return run(f"sudo kill {pid} && sleep 1 && ps -p {pid} || true")
    raise HTTPException(status_code=400, detail="Unsupported action")
