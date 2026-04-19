from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from ..models.entities import Approval, Host, Service, Task
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
        providers.append(
            {
                "key": "task-orchestrator",
                "name": "Task Orchestrator",
                "category": "execution",
                "description": "中央 AI 编排、连续任务状态机、审批恢复和结果总结模块。",
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
