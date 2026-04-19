from __future__ import annotations

import os
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
        "collected_at": now(),
    }


def metrics() -> dict[str, Any]:
    memory = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    return {
        "cpu_percent": psutil.cpu_percent(interval=0.2),
        "load_average": list(os.getloadavg()),
        "memory": {
            "total": memory.total,
            "used": memory.used,
            "available": memory.available,
            "percent": memory.percent,
        },
        "disk": {
            "total": disk.total,
            "used": disk.used,
            "free": disk.free,
            "percent": disk.percent,
        },
        "collected_at": now(),
    }


def discover_services() -> list[dict[str, Any]]:
    services: list[dict[str, Any]] = []
    for line in run("systemctl list-units --type=service --all --no-pager --no-legend | head -n 25")["stdout"].splitlines():
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
    for line in run("docker ps --format '{{.Names}}|{{.State}}|{{.Ports}}' 2>/dev/null || true")["stdout"].splitlines():
        if not line.strip():
            continue
        name, state, ports = (line.split("|") + ["", "", ""])[:3]
        services.append(
            {
                "service_key": f"docker:{name}",
                "name": name,
                "service_type": "container",
                "runtime_type": "docker",
                "status": state,
                "ports": [],
                "discovery_source": ["docker"],
                "evidence_json": {"raw": line},
                "confidence": 0.9,
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
    if action == "query_process":
        return run("ps aux | head -n 25")
    if action == "check_port":
        port = params.get("port")
        return run(f"ss -ltnp | grep ':{port}' || true")
    if action == "create_linux_user":
        return run(f"sudo useradd -m {params['username']}")
    if action == "delete_linux_user":
        return run(f"sudo userdel -r {params['username']}")
    if action == "diagnose_service":
        service = params.get("service_name") or "sshd"
        return run(f"systemctl status {service} --no-pager || true; journalctl -u {service} -n 40 --no-pager || true")
    raise HTTPException(status_code=400, detail="Unsupported action")
