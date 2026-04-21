from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass, field
from typing import Any

import httpx
from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool
from claude_agent_sdk.types import AssistantMessage, ResultMessage, ToolUseBlock
from sqlmodel import Session, select

from ..core.config import get_settings
from ..models.entities import Host, Service
from .platform import DashboardService, HostRepository, jsonable


settings = get_settings()


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
    def enabled() -> bool:
        return settings.claude_enabled and settings.agent_mode == "claude_sdk_gateway"

    @staticmethod
    def credentials_available() -> bool:
        return bool(
            ClaudeGatewayRuntime.enabled()
            and settings.gateway_base_url
            and settings.gateway_auth_token
            and settings.claude_model
        )

    @staticmethod
    def environment() -> dict[str, str]:
        env = {
            "ANTHROPIC_BASE_URL": settings.gateway_base_url.rstrip("/"),
            "ANTHROPIC_AUTH_TOKEN": settings.gateway_auth_token,
            "ANTHROPIC_CUSTOM_MODEL_OPTION": settings.gateway_custom_model_option,
            "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": settings.gateway_custom_model_option_name,
            "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION": settings.gateway_custom_model_option_description,
            "ANTHROPIC_MODEL": settings.claude_model,
            "ANTHROPIC_SMALL_FAST_MODEL": settings.claude_model,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": settings.claude_model,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": settings.claude_model,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": settings.claude_model,
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "API_TIMEOUT_MS": str(settings.gateway_timeout_seconds * 1000),
        }
        return {key: value for key, value in env.items() if value}

    @staticmethod
    def healthcheck() -> dict[str, Any]:
        if not ClaudeGatewayRuntime.enabled():
            return {
                "enabled": False,
                "reachable": False,
                "provider": settings.gateway_provider,
                "model": settings.gateway_model,
                "base_url": settings.gateway_base_url,
                "reason": "gateway disabled",
            }
        if not ClaudeGatewayRuntime.credentials_available():
            return {
                "enabled": True,
                "reachable": False,
                "provider": settings.gateway_provider,
                "model": settings.gateway_model,
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
                        "provider": settings.gateway_provider,
                        "model": settings.gateway_model,
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
            "provider": settings.gateway_provider,
            "model": settings.gateway_model,
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

        return create_sdk_mcp_server(
            "xfusion-control-plane",
            tools=[list_hosts_tool, selected_hosts_tool, dashboard_tool],
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

        mcp_servers = {}
        if session is not None:
            mcp_servers["xfusion-control-plane"] = ClaudeGatewayRuntime.build_control_plane_mcp_server(session)

        options = ClaudeAgentOptions(
            model=settings.claude_model,
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
                model=model_name or settings.claude_model,
                session_id=session_id,
                errors=errors,
            )

        try:
            effective_timeout = timeout_seconds or settings.gateway_timeout_seconds
            return await asyncio.wait_for(
                _run(),
                timeout=effective_timeout,
            )
        except Exception:
            return None
