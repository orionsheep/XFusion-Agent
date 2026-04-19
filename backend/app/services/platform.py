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
from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool
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
        input_payload = {
            "action_type": action_type,
            "parameters": parameters,
            "host": {
                "id": host.id,
                "name": host.name,
                "environment": host.environment,
                "risk_level": host.risk_level,
            },
        }
        if settings.opa_url:
            try:
                response = httpx.post(settings.opa_url, json={"input": input_payload}, timeout=4.0)
                response.raise_for_status()
                result = response.json().get("result", {})
                if isinstance(result, dict) and {"allowed", "risk_level", "approval_required"} <= set(result):
                    return result
                decision = result.get("decision") if isinstance(result, dict) else None
                if isinstance(decision, dict):
                    return decision
            except Exception:
                pass

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
            printf "os_name=%s\n" "$os_name"
            printf "os_version=%s\n" "$os_version"
            printf "kernel=%s\n" "$kernel"
            printf "package_manager=%s\n" "$package_manager"
            printf "systemd=%s\n" "$systemd"
            printf "docker=%s\n" "$docker"
            printf "podman=%s\n" "$podman"
            printf "compose=%s\n" "$compose"
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

        command = r"""
            set -e
            printf "load=%s\n" "$(uptime | sed 's/.*load averages*: //')"
            printf "mem_total_kb=%s\n" "$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
            printf "mem_available_kb=%s\n" "$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
            printf "disk_root=%s\n" "$(df -h / | awk 'NR==2 {print $5}')"
            echo "__TOP__"
            ps -eo pid,user,comm,%cpu,%mem --sort=-%cpu | head -n 8
        """
        result = await SSHConnector.run(host, credential, command, timeout_seconds=8)
        metrics: dict[str, Any] = {"raw": result}
        top_processes: list[dict[str, Any]] = []
        top_section = False
        for line in result["stdout"].splitlines():
            if line.strip() == "__TOP__":
                top_section = True
                continue
            if top_section:
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
            if "=" in line:
                key, value = line.strip().split("=", 1)
                metrics[key] = value
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
        docker_cmd = "docker ps --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Ports}}' 2>/dev/null || true"
        podman_cmd = "podman ps --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Ports}}' 2>/dev/null || true"
        pm2_cmd = "pm2 jlist 2>/dev/null || true"
        port_cmd = "ss -ltnp 2>/dev/null | tail -n +2 | head -n 40 || true"

        systemd_result = await SSHConnector.run(host, credential, systemd_cmd, timeout_seconds=8)
        for line in systemd_result["stdout"].splitlines():
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

        docker_result = await SSHConnector.run(host, credential, docker_cmd, timeout_seconds=8)
        for line in docker_result["stdout"].splitlines():
            if not line.strip():
                continue
            name, image, state, ports = (line.split("|") + ["", "", "", ""])[:4]
            port_values = [int(match) for match in re.findall(r":(\d+)->", ports)]
            services.append(
                {
                    "service_key": f"docker:{name}",
                    "name": name,
                    "service_type": "container",
                    "runtime_type": "docker",
                    "status": state or "unknown",
                    "ports": port_values,
                    "discovery_source": ["docker"],
                    "evidence_json": {"raw": line, "image": image},
                    "confidence": 0.9,
                }
            )

        podman_result = await SSHConnector.run(host, credential, podman_cmd, timeout_seconds=8)
        for line in podman_result["stdout"].splitlines():
            if not line.strip():
                continue
            name, image, state, ports = (line.split("|") + ["", "", "", ""])[:4]
            port_values = [int(match) for match in re.findall(r":(\d+)->", ports)]
            services.append(
                {
                    "service_key": f"podman:{name}",
                    "name": name,
                    "service_type": "container",
                    "runtime_type": "podman",
                    "status": state or "unknown",
                    "ports": port_values,
                    "discovery_source": ["podman"],
                    "evidence_json": {"raw": line, "image": image},
                    "confidence": 0.88,
                }
            )

        pm2_result = await SSHConnector.run(host, credential, pm2_cmd, timeout_seconds=8)
        if pm2_result["success"] and pm2_result["stdout"].strip().startswith("["):
            try:
                pm2_apps = json.loads(pm2_result["stdout"])
                for item in pm2_apps[:20]:
                    services.append(
                        {
                            "service_key": f"pm2:{item.get('name')}",
                            "name": item.get("name") or "pm2-app",
                            "service_type": "application",
                            "runtime_type": "pm2",
                            "status": item.get("pm2_env", {}).get("status", "unknown"),
                            "ports": [],
                            "discovery_source": ["pm2"],
                            "evidence_json": item,
                            "confidence": 0.86,
                        }
                    )
            except Exception:
                pass

        port_result = await SSHConnector.run(host, credential, port_cmd, timeout_seconds=8)
        for line in port_result["stdout"].splitlines():
            ports = [int(match) for match in re.findall(r":(\d+)\s", line)]
            if ports:
                services.append(
                    {
                        "service_key": f"port:{ports[0]}",
                        "name": f"port-{ports[0]}",
                        "service_type": "listener",
                        "runtime_type": "process",
                        "status": "listening",
                        "ports": ports,
                        "discovery_source": ["socket-scan"],
                        "evidence_json": {"raw": line},
                        "confidence": 0.65,
                    }
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
        has_credentials = any(
            os.getenv(name)
            for name in ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]
        )
        if not settings.claude_enabled or not has_credentials:
            return None
        try:
            mcp_server = build_claude_tools(session)
            async def _run_query() -> dict[str, Any] | None:
                async for message in query(
                    prompt=(
                        "You are an operations planner. Convert the user request into JSON with "
                        "keys summary, risk_hint, target_guess. Use available tools when useful. "
                        f"User request: {prompt}\nContext: {json.dumps(context, ensure_ascii=False)}"
                    ),
                    options=ClaudeAgentOptions(
                        system_prompt="Return concise JSON only.",
                        model=settings.claude_model,
                        permission_mode="plan",
                        max_turns=1,
                        mcp_servers={"xfusion": mcp_server},
                        allowed_tools=["list_hosts", "get_dashboard_summary"],
                    ),
                ):
                    if getattr(message, "type", None) == "result":
                        text = getattr(message, "result", "")
                        return {"raw": text}
                return None

            return await asyncio.wait_for(_run_query(), timeout=8)
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
        hosts = list(session.exec(select(Host)).all())
        services = list(session.exec(select(Service)).all())
        tasks = list(session.exec(select(Task).order_by(Task.id.desc()).limit(10)).all())
        approvals = list(session.exec(select(Approval).order_by(Approval.id.desc()).limit(10)).all())
        return {
            "stats": {
                "hosts": len(hosts),
                "online_hosts": len([host for host in hosts if host.status in {"online", "registered"}]),
                "services": len(services),
                "pending_approvals": len([approval for approval in approvals if approval.status == "pending"]),
                "recent_tasks": len(tasks),
            },
            "hosts": [serialize_model(host) for host in hosts[:20]],
            "services": [serialize_model(service) for service in services[:20]],
            "tasks": [serialize_model(task) for task in tasks],
            "approvals": [serialize_model(approval) for approval in approvals],
        }


def build_claude_tools(session: Session):
    @tool("list_hosts", "List all managed hosts", {})
    async def list_hosts_tool(_: dict[str, Any]) -> dict[str, Any]:
        hosts = HostRepository.list_hosts(session)
        return {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(
                        [
                            {"id": host.id, "name": host.name, "address": host.address, "status": host.status}
                            for host in hosts
                        ],
                        ensure_ascii=False,
                    ),
                }
            ]
        }

    @tool("get_dashboard_summary", "Get dashboard summary", {})
    async def dashboard_tool(_: dict[str, Any]) -> dict[str, Any]:
        summary = DashboardService.overview(session)
        return {"content": [{"type": "text", "text": json.dumps(summary, ensure_ascii=False)}]}

    return create_sdk_mcp_server("xfusion-control-plane", tools=[list_hosts_tool, dashboard_tool])
