from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool
from claude_agent_sdk.types import AssistantMessage, ResultMessage, ToolUseBlock
from sqlmodel import Session, select

from ..core.config import ROOT_DIR, get_settings
from ..models.entities import Host, Service
from .platform import DashboardService, HostRepository, jsonable


settings = get_settings()
RUNTIME_PROFILE_PATH = ROOT_DIR / "backend" / "runtime_profile.json"
SUPPORTED_GATEWAY_ALIASES: dict[str, dict[str, str]] = {
    "MiniMax-M2.7": {
        "provider": "minimax",
        "description": "MiniMax-M2.7 routed through LiteLLM",
    },
    "GLM-4.5": {
        "provider": "zhipu",
        "description": "GLM-4.5 routed through LiteLLM",
    },
}


def _extract_json_payload(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = stripped.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        value = json.loads(stripped)
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def _tool_text(payload: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(jsonable(payload), ensure_ascii=False)}]}


@dataclass
class ClaudeJsonResult:
    payload: dict[str, Any] | None
    raw_text: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    model: str | None = None
    session_id: str | None = None
    errors: list[str] = field(default_factory=list)


class ClaudeGatewayRuntime:
    @staticmethod
    def _default_profile() -> dict[str, Any]:
        description = SUPPORTED_GATEWAY_ALIASES.get(
            settings.claude_model,
            {"description": settings.gateway_custom_model_option_description},
        )["description"]
        return {
            "claude_model": settings.claude_model,
            "gateway_custom_model_option": settings.gateway_custom_model_option,
            "gateway_custom_model_option_name": settings.gateway_custom_model_option_name,
            "gateway_custom_model_option_description": description,
            "gateway_provider": settings.gateway_provider,
            "gateway_model": settings.gateway_model,
        }

    @staticmethod
    def current_profile() -> dict[str, Any]:
        profile = ClaudeGatewayRuntime._default_profile()
        if RUNTIME_PROFILE_PATH.exists():
            try:
                data = json.loads(RUNTIME_PROFILE_PATH.read_text())
                if isinstance(data, dict):
                    profile.update({key: value for key, value in data.items() if value})
            except Exception:
                pass
        alias = str(profile.get("claude_model") or profile.get("gateway_model") or settings.claude_model)
        defaults = SUPPORTED_GATEWAY_ALIASES.get(alias, {})
        profile["claude_model"] = alias
        profile["gateway_custom_model_option"] = alias
        profile["gateway_custom_model_option_name"] = alias
        profile["gateway_custom_model_option_description"] = defaults.get(
            "description",
            profile.get("gateway_custom_model_option_description") or f"{alias} routed through LiteLLM",
        )
        profile["gateway_provider"] = profile.get("gateway_provider") or defaults.get("provider") or settings.gateway_provider
        profile["gateway_model"] = profile.get("gateway_model") or alias
        return profile

    @staticmethod
    def save_profile(*, model_alias: str, provider: str | None = None) -> dict[str, Any]:
        alias = model_alias.strip()
        if not alias:
            raise ValueError("model_alias is required")
        defaults = SUPPORTED_GATEWAY_ALIASES.get(alias, {})
        payload = {
            "claude_model": alias,
            "gateway_custom_model_option": alias,
            "gateway_custom_model_option_name": alias,
            "gateway_custom_model_option_description": defaults.get("description", f"{alias} routed through LiteLLM"),
            "gateway_provider": provider or defaults.get("provider") or settings.gateway_provider,
            "gateway_model": alias,
        }
        RUNTIME_PROFILE_PATH.parent.mkdir(parents=True, exist_ok=True)
        RUNTIME_PROFILE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
        return ClaudeGatewayRuntime.current_profile()

    @staticmethod
    def available_models() -> list[str]:
        models = list(SUPPORTED_GATEWAY_ALIASES.keys())
        try:
            status = ClaudeGatewayRuntime.healthcheck()
            for model in status.get("models") or []:
                if isinstance(model, str) and model not in models:
                    models.append(model)
        except Exception:
            pass
        return models

    @staticmethod
    def enabled() -> bool:
        return settings.claude_enabled and settings.agent_mode == "claude_sdk_gateway"

    @staticmethod
    def credentials_available() -> bool:
        profile = ClaudeGatewayRuntime.current_profile()
        return bool(
            ClaudeGatewayRuntime.enabled()
            and settings.gateway_base_url
            and settings.gateway_auth_token
            and profile.get("claude_model")
        )

    @staticmethod
    def gateway_reachable(timeout_seconds: float = 0.8) -> bool:
        if not ClaudeGatewayRuntime.credentials_available():
            return False
        headers = {"Authorization": f"Bearer {settings.gateway_auth_token}"}
        base = settings.gateway_base_url.rstrip("/")
        try:
            with httpx.Client(timeout=timeout_seconds) as client:
                response = client.get(f"{base}/v1/models", headers=headers)
            return response.is_success
        except Exception:
            return False

    @staticmethod
    def environment() -> dict[str, str]:
        profile = ClaudeGatewayRuntime.current_profile()
        env = {
            "ANTHROPIC_BASE_URL": settings.gateway_base_url.rstrip("/"),
            "ANTHROPIC_AUTH_TOKEN": settings.gateway_auth_token,
            "ANTHROPIC_CUSTOM_MODEL_OPTION": profile["gateway_custom_model_option"],
            "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": profile["gateway_custom_model_option_name"],
            "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": profile["gateway_custom_model_option_description"],
            "ANTHROPIC_MODEL": profile["claude_model"],
            "ANTHROPIC_SMALL_FAST_MODEL": profile["claude_model"],
            "ANTHROPIC_DEFAULT_SONNET_MODEL": profile["claude_model"],
            "ANTHROPIC_DEFAULT_OPUS_MODEL": profile["claude_model"],
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": profile["claude_model"],
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "API_TIMEOUT_MS": str(settings.gateway_timeout_seconds * 1000),
        }
        return {key: value for key, value in env.items() if value}

    @staticmethod
    def healthcheck() -> dict[str, Any]:
        profile = ClaudeGatewayRuntime.current_profile()
        if not ClaudeGatewayRuntime.enabled():
            return {
                "enabled": False,
                "reachable": False,
                "provider": profile["gateway_provider"],
                "model": profile["gateway_model"],
                "base_url": settings.gateway_base_url,
                "reason": "gateway disabled",
            }
        if not ClaudeGatewayRuntime.credentials_available():
            return {
                "enabled": True,
                "reachable": False,
                "provider": profile["gateway_provider"],
                "model": profile["gateway_model"],
                "base_url": settings.gateway_base_url,
                "reason": "missing gateway credentials",
            }

        headers = {"Authorization": f"Bearer {settings.gateway_auth_token}"}
        base = settings.gateway_base_url.rstrip("/")
        endpoints = [f"{base}/v1/models", f"{base}/health", f"{base}/health/readiness"]
        for url in endpoints:
            try:
                with httpx.Client(timeout=3.0) as client:
                    response = client.get(url, headers=headers)
                if response.is_success:
                    data = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
                    models = data.get("data") if isinstance(data, dict) else None
                    model_names = [item.get("id") for item in models or [] if isinstance(item, dict)]
                    return {
                        "enabled": True,
                        "reachable": True,
                        "provider": profile["gateway_provider"],
                        "model": profile["gateway_model"],
                        "base_url": settings.gateway_base_url,
                        "models": model_names,
                        "model_count": len(model_names),
                        "checked_endpoint": url,
                    }
            except Exception as exc:
                last_error = str(exc)
        return {
            "enabled": True,
            "reachable": False,
            "provider": profile["gateway_provider"],
            "model": profile["gateway_model"],
            "base_url": settings.gateway_base_url,
            "reason": locals().get("last_error", "unreachable"),
        }

    @staticmethod
    def build_control_plane_mcp_server(session: Session):
        @tool("list_hosts", "List all managed hosts available to the control plane.", {})
        async def list_hosts_tool(_: dict[str, Any]) -> dict[str, Any]:
            hosts = HostRepository.list_hosts(session)
            return _tool_text(
                {
                    "hosts": [
                        {
                            "id": host.id,
                            "name": host.name,
                            "address": host.address,
                            "status": host.status,
                            "environment": host.environment,
                            "connection_mode": host.connection_mode,
                        }
                        for host in hosts
                    ]
                }
            )

        @tool(
            "get_selected_hosts_snapshot",
            "Get stored profile, metrics, and discovered services for specific managed hosts.",
            {
                "type": "object",
                "properties": {
                    "host_ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "minItems": 1,
                    }
                },
                "required": ["host_ids"],
                "additionalProperties": False,
            },
        )
        async def selected_hosts_tool(arguments: dict[str, Any]) -> dict[str, Any]:
            host_ids = [int(host_id) for host_id in arguments.get("host_ids", [])]
            snapshots: list[dict[str, Any]] = []
            for host_id in host_ids:
                host = session.get(Host, host_id)
                if not host:
                    continue
                services = list(session.exec(select(Service).where(Service.host_id == host_id)).all())
                snapshots.append(
                    {
                        "host": {
                            "id": host.id,
                            "name": host.name,
                            "address": host.address,
                            "status": host.status,
                            "environment": host.environment,
                            "os_type": host.os_type,
                            "os_version": host.os_version,
                            "package_manager": host.package_manager,
                            "profile": host.profile_json,
                            "metrics": host.metrics_json,
                        },
                        "services": [
                            {
                                "id": service.id,
                                "name": service.name,
                                "service_type": service.service_type,
                                "runtime_type": service.runtime_type,
                                "status": service.status,
                                "ports": service.ports,
                                "evidence_json": service.evidence_json,
                            }
                            for service in services[:25]
                        ],
                    }
                )
            return _tool_text({"snapshots": snapshots})

        @tool("get_dashboard_summary", "Get the current fleet dashboard summary.", {})
        async def dashboard_tool(_: dict[str, Any]) -> dict[str, Any]:
            return _tool_text({"overview": DashboardService.overview(session)})

        @tool("get_execution_capabilities", "List the safe action types this control plane can execute.", {})
        async def capabilities_tool(_: dict[str, Any]) -> dict[str, Any]:
            return _tool_text(
                {
                    "actions": [
                        {
                            "action_type": "run_readonly_command",
                            "risk": "L0",
                            "description": "Generic read-only shell probes. Parameters: commands: string[]. State-changing commands are blocked by policy.",
                        },
                        {
                            "action_type": "discover_services",
                            "risk": "L0",
                            "description": "Discover systemd, Docker, Docker Compose, PM2, Supervisor, Kubernetes and listening port services.",
                        },
                        {"action_type": "query_disk", "risk": "L0", "description": "Read filesystem usage."},
                        {"action_type": "check_host_status", "risk": "L0", "description": "Read host connectivity and basic health."},
                        {"action_type": "inspect_databases", "risk": "L0", "description": "Scan database ports, processes and discovered DB workloads."},
                        {"action_type": "search_files", "risk": "L0", "description": "Find files or directories within a safe path scope."},
                        {"action_type": "check_port", "risk": "L0", "description": "Inspect a listening TCP port."},
                        {"action_type": "query_process", "risk": "L0", "description": "Inspect processes."},
                        {"action_type": "diagnose_service", "risk": "L1", "description": "Collect status, logs and sockets for one service."},
                        {"action_type": "restart_service", "risk": "L3", "description": "Restart a service after human approval."},
                        {"action_type": "kill_process", "risk": "L3", "description": "Kill a process after human approval."},
                        {"action_type": "create_linux_user", "risk": "L3", "description": "Create a Linux user after approval."},
                        {"action_type": "delete_linux_user", "risk": "L3", "description": "Delete a Linux user after approval."},
                    ],
                    "blocked": ["delete_path", "modify_security_config", "bulk_permission_change"],
                }
            )

        @tool(
            "get_database_inventory",
            "Get database-like services already discovered on selected hosts.",
            {
                "type": "object",
                "properties": {
                    "host_ids": {
                        "type": "array",
                        "items": {"type": "integer"},
                    }
                },
                "required": ["host_ids"],
                "additionalProperties": False,
            },
        )
        async def database_inventory_tool(arguments: dict[str, Any]) -> dict[str, Any]:
            host_ids = [int(host_id) for host_id in arguments.get("host_ids", [])]
            rows = list(session.exec(select(Service).where(Service.host_id.in_(host_ids))).all()) if host_ids else []
            databases = []
            for service in rows:
                evidence = service.evidence_json or {}
                if evidence.get("workload") != "database" and not evidence.get("database_engine"):
                    continue
                host = session.get(Host, service.host_id)
                databases.append(
                    {
                        "host": {
                            "id": service.host_id,
                            "name": host.name if host else f"host-{service.host_id}",
                        },
                        "name": service.name,
                        "runtime_type": service.runtime_type,
                        "status": service.status,
                        "ports": service.ports,
                        "engine": evidence.get("database_engine") or "database",
                        "source": evidence.get("discovery_source") or evidence.get("source"),
                    }
                )
            return _tool_text({"databases": databases})

        return create_sdk_mcp_server(
            "xfusion-control-plane",
            tools=[list_hosts_tool, selected_hosts_tool, dashboard_tool, capabilities_tool, database_inventory_tool],
        )

    @staticmethod
    async def run_json_query(
        *,
        prompt: str,
        system_prompt: str,
        schema: dict[str, Any],
        session: Session | None = None,
        max_turns: int = 3,
        timeout_seconds: int | None = None,
    ) -> ClaudeJsonResult | None:
        if not ClaudeGatewayRuntime.credentials_available():
            return None
        if not ClaudeGatewayRuntime.gateway_reachable():
            return ClaudeJsonResult(
                payload=None,
                errors=[f"Claude Agent SDK gateway unreachable: {settings.gateway_base_url}"],
            )

        mcp_servers = {}
        if session is not None:
            mcp_servers["xfusion-control-plane"] = ClaudeGatewayRuntime.build_control_plane_mcp_server(session)

        profile = ClaudeGatewayRuntime.current_profile()
        options = ClaudeAgentOptions(
            model=profile["claude_model"],
            system_prompt=system_prompt,
            permission_mode="bypassPermissions",
            max_turns=max(max_turns, 4),
            cwd=".",
            tools=[],
            mcp_servers=mcp_servers,
            env=ClaudeGatewayRuntime.environment(),
            output_format={"type": "json_schema", "schema": schema},
            effort="high",
            setting_sources=["local"],
        )

        async def _run() -> ClaudeJsonResult:
            raw_text = ""
            structured_output: dict[str, Any] | None = None
            tool_calls: list[dict[str, Any]] = []
            model_name: str | None = None
            session_id: str | None = None
            errors: list[str] = []

            async for message in query(prompt=prompt, options=options):
                if isinstance(message, AssistantMessage):
                    model_name = message.model or model_name
                    session_id = message.session_id or session_id
                    for block in message.content:
                        if isinstance(block, ToolUseBlock):
                            if block.name == "StructuredOutput" and isinstance(block.input, dict):
                                structured_output = jsonable(block.input)
                            tool_calls.append(
                                {
                                    "id": block.id,
                                    "name": block.name,
                                    "input": jsonable(block.input),
                                }
                            )
                        text = getattr(block, "text", None)
                        if isinstance(text, str) and text.strip():
                            raw_text = text.strip()
                elif isinstance(message, ResultMessage):
                    session_id = message.session_id or session_id
                    if isinstance(message.result, str) and message.result.strip():
                        raw_text = message.result.strip()
                    if isinstance(message.structured_output, dict):
                        structured_output = jsonable(message.structured_output)
                    if message.errors:
                        errors.extend(message.errors)

            return ClaudeJsonResult(
                payload=structured_output or _extract_json_payload(raw_text),
                raw_text=raw_text,
                tool_calls=tool_calls,
                model=model_name or profile["claude_model"],
                session_id=session_id,
                errors=errors,
            )

        effective_timeout = timeout_seconds or settings.gateway_timeout_seconds
        last_result: ClaudeJsonResult | None = None
        for attempt in range(2):
            try:
                result = await asyncio.wait_for(
                    _run(),
                    timeout=effective_timeout,
                )
                if result.payload is not None or result.tool_calls:
                    return result
                last_result = result
            except Exception as exc:
                last_result = ClaudeJsonResult(payload=None, errors=[str(exc)])
            if attempt == 0:
                await asyncio.sleep(0.35)
        return last_result
