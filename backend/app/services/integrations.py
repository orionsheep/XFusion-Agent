from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from ..models.entities import Approval, Host, Service, Task
from .claude_runtime import ClaudeGatewayRuntime
from .monitoring import MonitoringCoreService


class CapabilityCatalog:
    @staticmethod
    def summary(session: Session) -> dict[str, Any]:
        monitoring = MonitoringCoreService.internal_capabilities(session)
        hosts = list(session.exec(select(Host)).all())
        services = list(session.exec(select(Service)).all())
        tasks = list(session.exec(select(Task)).all())
        approvals = list(session.exec(select(Approval)).all())
        providers = monitoring["providers"]
        gateway_status = ClaudeGatewayRuntime.healthcheck()
        providers.append(
            {
                "key": "claude-sdk-gateway",
                "name": "Claude Agent SDK Gateway",
                "category": "ai-runtime",
                "description": "Claude Agent SDK 通过 LiteLLM Anthropic-compatible gateway 路由到 MiniMax。",
                "status": {
                    "enabled": bool(gateway_status.get("enabled")),
                    "reachable": bool(gateway_status.get("reachable")),
                },
                "stats": {
                    "provider": gateway_status.get("provider"),
                    "model": gateway_status.get("model"),
                    "base_url": gateway_status.get("base_url"),
                    "model_count": gateway_status.get("model_count", 0),
                    "checked_endpoint": gateway_status.get("checked_endpoint"),
                    "reason": gateway_status.get("reason"),
                },
            }
        )
        providers.append(
            {
                "key": "task-orchestrator",
                "name": "Task Orchestrator",
                "category": "execution",
                "description": "中央 AI 编排、连续任务状态机、审批恢复和结果总结模块；主链使用 Claude Agent SDK。",
                "status": {"enabled": True, "reachable": True},
                "stats": {
                    "hosts": len(hosts),
                    "services": len(services),
                    "tasks": len(tasks),
                    "pending_approvals": len([item for item in approvals if item.status == "pending"]),
                },
            }
        )
        return {
            "providers": providers,
            "actions": monitoring["actions"],
        }
