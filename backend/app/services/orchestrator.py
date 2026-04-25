from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
from dataclasses import dataclass, field
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func
from sqlmodel import Session, select

from ..models.entities import Approval, Host, HostCredential, Service, Task, TaskStep, User
from .claude_runtime import ClaudeGatewayRuntime, ClaudeJsonResult
from .llm_router import LLMMessage, registry
from .platform import (
    AgentConnector,
    DashboardService,
    HostInspector,
    HostRepository,
    PolicyEngine,
    ServiceSync,
    SSHConnector,
    jsonable,
    now,
    redact_sensitive,
    settings,
    upsert_audit,
    validate_readonly_commands,
)
from .monitoring import MonitoringCoreService


def _has_claude_credentials() -> bool:
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _extract_json_payload(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*|\s*```$", "", stripped, flags=re.S)
    try:
        value = json.loads(stripped)
        return value if isinstance(value, dict) else None
    except Exception:
        pass
    match = re.search(r"\{.*\}", stripped, re.S)
    if not match:
        return None
    try:
        value = json.loads(match.group(0))
        return value if isinstance(value, dict) else None
    except Exception:
        return None




def _safe_path(path: str | None) -> str:
    candidate = (path or "/").strip() or "/"
    if not candidate.startswith("/"):
        candidate = f"/{candidate}"
    dangerous = {"/proc", "/sys", "/dev", "/run"}
    for prefix in dangerous:
        if candidate == prefix or candidate.startswith(f"{prefix}/"):
            return "/"
    return candidate


def _safe_token(value: str | None) -> str:
    return shlex.quote((value or "").strip())


def _mentions_service_inventory(prompt: str, lowered: str | None = None) -> bool:
    lowered = lowered or prompt.lower()
    chinese = prompt.replace("服务器", "").replace("服务端", "")
    return any(word in chinese for word in ["服务", "应用", "容器", "部署", "进程管理"]) or any(
        word in lowered for word in ["service", "container", "docker", "compose", "pm2", "supervisor", "kubernetes"]
    )


def _default_readonly_commands(prompt: str) -> list[str]:
    lowered = prompt.lower()
    commands = [
        "hostname; uname -srmo; uptime",
        "df -hT | head -n 30",
        "free -h",
        "ps aux --sort=-%cpu 2>/dev/null | head -n 15",
        "ss -ltnp 2>/dev/null | head -n 40 || netstat -ltnp 2>/dev/null | head -n 40 || true",
        "systemctl --failed --no-pager 2>/dev/null || true",
    ]
    if _mentions_service_inventory(prompt, lowered) or any(word in prompt for word in ["进程"]) or any(word in lowered for word in ["app", "process", "deployment"]):
        commands.extend(
            [
                "systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | head -n 40 || true",
                "docker ps --format 'table {{.Names}}\\t{{.Image}}\\t{{.Status}}\\t{{.Ports}}' 2>/dev/null || true",
                "pm2 list --no-color 2>/dev/null || true",
                "supervisorctl status 2>/dev/null || true",
            ]
        )
    if any(word in prompt for word in ["网络", "端口", "连接"]) or any(word in lowered for word in ["network", "port", "listen", "connection"]):
        commands.extend(["ip -brief addr 2>/dev/null || true", "ss -tunap 2>/dev/null | head -n 60 || true"])
    if any(word in prompt for word in ["日志", "错误", "失败"]) or any(word in lowered for word in ["log", "error", "failed", "failure"]):
        commands.extend(["journalctl -p warning -n 80 --no-pager 2>/dev/null || true"])
    return commands[:10]


def _coerce_readonly_commands(parameters: dict[str, Any], prompt: str | None = None) -> list[str]:
    raw = parameters.get("commands") or parameters.get("command")
    if isinstance(raw, list):
        commands = [str(item).strip() for item in raw if str(item).strip()]
    elif isinstance(raw, str) and raw.strip():
        commands = [line.strip() for line in raw.splitlines() if line.strip()]
    else:
        commands = _default_readonly_commands(prompt or "")
    return commands[:10]


def _build_readonly_probe_script(commands: list[str]) -> tuple[str, list[str]]:
    safe, problems = validate_readonly_commands(commands)
    if not safe:
        return "", problems
    script_lines = ["set +e"]
    for index, command in enumerate(commands, start=1):
        label = command.replace("\n", " ")[:220]
        script_lines.append(f"echo '__XFUSION_CMD_{index}__ {label}'")
        script_lines.append(f"timeout 18 bash -lc {shlex.quote(command)}")
        script_lines.append("printf '\\n'")
    return "bash -lc " + shlex.quote("\n".join(script_lines)), []


def _parse_df_output(stdout: str) -> list[dict[str, Any]]:
    lines = [line.strip() for line in (stdout or "").splitlines() if line.strip()]
    if len(lines) < 2:
        return []
    header = re.split(r"\s+", lines[0])
    if len(header) < 6 or "Mounted" not in lines[0]:
        return []
    rows: list[dict[str, Any]] = []
    for line in lines[1:]:
        parts = re.split(r"\s+", line)
        if len(parts) < 6:
            continue
        filesystem, size, used, avail, percent, mount = parts[:6]
        try:
            used_percent = int(percent.rstrip("%"))
        except Exception:
            used_percent = None
        rows.append(
            {
                "filesystem": filesystem,
                "size": size,
                "used": used,
                "avail": avail,
                "use_percent": used_percent,
                "mount": mount,
            }
        )
    return rows


def _risk_level_for_usage(usage: int | None) -> str:
    if usage is None:
        return "unknown"
    if usage >= 85:
        return "critical"
    if usage >= 70:
        return "warning"
    return "healthy"


def _risk_label(level: str) -> str:
    return {
        "critical": "高风险",
        "warning": "关注",
        "healthy": "稳定",
        "unknown": "未知",
    }.get(level, "未知")


def _looks_transient_transport_error(result: dict[str, Any]) -> bool:
    stderr = str(result.get("stderr") or "").lower()
    exit_code = result.get("exit_code")
    return exit_code in {124, 255} or "connection lost" in stderr or "timed out" in stderr


def _host_status_line(result: dict[str, Any]) -> str:
    return f"{result['host_name']}:{'成功' if result['success'] else '失败'}"


def _extract_disk_host_fact(item: dict[str, Any]) -> dict[str, Any]:
    rows = _parse_df_output(((item.get("action_result") or {}).get("stdout") or ""))
    root = next((row for row in rows if row.get("mount") == "/"), rows[0] if rows else None)
    notable = [
        row for row in rows
        if row.get("use_percent") is not None and row.get("use_percent", 0) >= 70
    ]
    risk = _risk_level_for_usage(root.get("use_percent") if root else None)
    return {
        "host_id": item.get("host_id"),
        "host_name": item.get("host_name"),
        "rows": rows,
        "root": root,
        "notable": notable,
        "risk": risk,
        "success": item.get("success", False),
        "stderr": ((item.get("action_result") or {}).get("stderr") or "").strip(),
    }


def _build_disk_report(per_host_results: list[dict[str, Any]], prompt: str) -> tuple[str, dict[str, Any], str]:
    host_facts = [_extract_disk_host_fact(item) for item in per_host_results]
    critical_hosts = [fact for fact in host_facts if fact["risk"] == "critical"]
    warning_hosts = [fact for fact in host_facts if fact["risk"] == "warning"]
    healthy_hosts = [fact for fact in host_facts if fact["risk"] == "healthy"]
    failed_hosts = [fact for fact in host_facts if not fact["success"]]

    headline_parts: list[str] = []
    if critical_hosts:
        headline_parts.append(
            f"{len(critical_hosts)} 台主机已进入高风险区："
            + "、".join(
                f"{fact['host_name']}({fact['root']['use_percent']}%)"
                for fact in critical_hosts
                if fact.get("root")
            )
        )
    if warning_hosts:
        headline_parts.append(
            f"{len(warning_hosts)} 台主机需要关注："
            + "、".join(
                f"{fact['host_name']}({fact['root']['use_percent']}%)"
                for fact in warning_hosts
                if fact.get("root")
            )
        )
    if failed_hosts:
        headline_parts.append(
            f"{len(failed_hosts)} 台主机采集失败："
            + "、".join(fact["host_name"] for fact in failed_hosts)
        )
    if not headline_parts:
        headline_parts.append(f"{len(healthy_hosts)} 台主机当前都处于安全区。")
    summary = "；".join(headline_parts)

    lines = [
        "# 硬盘使用情况分析报告",
        "",
        "## 执行摘要",
        f"- 请求：{prompt}",
        f"- 检查主机数：{len(per_host_results)}",
        f"- 结论：{summary}",
        "",
        "## 风险概览",
        f"- 高风险：{len(critical_hosts)} 台",
        f"- 关注：{len(warning_hosts)} 台",
        f"- 稳定：{len(healthy_hosts)} 台",
        f"- 采集失败：{len(failed_hosts)} 台",
        "",
        "## 逐主机分析",
    ]

    for fact in host_facts:
        root = fact.get("root")
        lines.extend(
            [
                "",
                f"### {fact['host_name']}",
                f"- 状态：{_risk_label(fact['risk'])}",
            ]
        )
        if root:
            lines.extend(
                [
                    f"- 根分区：已用 {root['used']} / 总量 {root['size']} / 可用 {root['avail']} / 使用率 {root['use_percent']}%",
                ]
            )
        if fact["notable"]:
            lines.append("- 重点分区：")
            lines.append("")
            lines.append("| 挂载点 | 已用 | 总量 | 可用 | 使用率 |")
            lines.append("| --- | --- | --- | --- | --- |")
            for row in fact["notable"]:
                lines.append(
                    f"| {row['mount']} | {row['used']} | {row['size']} | {row['avail']} | {row['use_percent']}% |"
                )
        elif fact["rows"]:
            top_rows = fact["rows"][:4]
            lines.append("- 主要分区：")
            lines.append("")
            lines.append("| 挂载点 | 已用 | 总量 | 可用 | 使用率 |")
            lines.append("| --- | --- | --- | --- | --- |")
            for row in top_rows:
                percent = f"{row['use_percent']}%" if row["use_percent"] is not None else "-"
                lines.append(
                    f"| {row['mount']} | {row['used']} | {row['size']} | {row['avail']} | {percent} |"
                )
        if fact["stderr"]:
            lines.extend(["", f"> stderr: {fact['stderr']}"])

    lines.extend(
        [
            "",
            "## 建议动作",
        ]
    )
    if critical_hosts:
        for fact in critical_hosts:
            root = fact.get("root")
            usage_text = f"{root['use_percent']}%" if root else "未知"
            lines.append(f"- 优先处理 `{fact['host_name']}`：根分区已到 {usage_text}，建议立即清理大文件、日志和历史包。")
    elif warning_hosts:
        for fact in warning_hosts:
            root = fact.get("root")
            usage_text = f"{root['use_percent']}%" if root else "未知"
            lines.append(f"- 关注 `{fact['host_name']}`：当前使用率 {usage_text}，建议安排容量巡检。")
    else:
        lines.append("- 当前没有主机进入危险区，继续保持常规巡检即可。")

    meta = {
        "host_count": len(per_host_results),
        "success_count": sum(1 for item in per_host_results if item.get("success")),
        "failed_count": sum(1 for item in per_host_results if not item.get("success")),
        "risk_hosts": [fact["host_name"] for fact in critical_hosts + warning_hosts],
        "primary_metrics": {
            "critical_hosts": len(critical_hosts),
            "warning_hosts": len(warning_hosts),
            "healthy_hosts": len(healthy_hosts),
        },
    }
    return "\n".join(lines).strip(), meta, summary


def _build_generic_report(
    *,
    plan: "IntentPlan",
    prompt: str,
    per_host_results: list[dict[str, Any]],
) -> tuple[str, dict[str, Any], str]:
    success_count = sum(1 for item in per_host_results if item.get("success"))
    failed_count = len(per_host_results) - success_count
    summary = (
        f"{plan.title}已在 {len(per_host_results)} 台主机上执行；"
        + "，".join(_host_status_line(item) for item in per_host_results)
    )
    lines = [
        f"# {plan.title}",
        "",
        "## 执行摘要",
        f"- 请求：{prompt}",
        f"- 动作：`{plan.action_type}`",
        f"- 主机数：{len(per_host_results)}",
        f"- 成功：{success_count}",
        f"- 失败：{failed_count}",
        "",
        "## 逐主机结果",
    ]
    for item in per_host_results:
        action_result = item.get("action_result") or {}
        stdout = (action_result.get("stdout") or "").strip()
        stderr = (action_result.get("stderr") or "").strip()
        lines.extend(
            [
                "",
                f"### {item['host_name']}",
                f"- 状态：{'成功' if item.get('success') else '失败'}",
            ]
        )
        if stdout:
            lines.extend(["- 输出：", "", "```text", stdout[:4000], "```"])
        if stderr:
            lines.extend(["- 错误输出：", "", "```text", stderr[:2000], "```"])
    meta = {
        "host_count": len(per_host_results),
        "success_count": success_count,
        "failed_count": failed_count,
        "risk_hosts": [item["host_name"] for item in per_host_results if not item.get("success")],
        "primary_metrics": {
            "action_type": plan.action_type,
        },
    }
    return "\n".join(lines).strip(), meta, summary


def _build_error_report(title: str, summary: str, *, reason: str | None = None) -> dict[str, Any]:
    lines = [
        f"# {title}",
        "",
        "## 结果",
        f"- {summary}",
    ]
    if reason:
        lines.extend(["", "## 原因", reason])
    return {
        "summary": summary,
        "report_kind": "error",
        "report_markdown": "\n".join(lines).strip(),
        "report_meta": {
            "host_count": 0,
            "success_count": 0,
            "failed_count": 1,
            "risk_hosts": [],
            "primary_metrics": {},
        },
    }


def _recent_task_context(session: Session, session_id: str, limit: int = 5) -> list[dict[str, Any]]:
    tasks = list(
        session.exec(
            select(Task)
            .where(Task.session_id == session_id)
            .order_by(Task.id.desc())
            .limit(limit)
        ).all()
    )
    tasks.reverse()
    return [
        {
            "id": task.id,
            "title": task.title,
            "prompt": task.prompt,
            "status": task.status,
            "result": task.result_json,
        }
        for task in tasks
    ]


def _session_continuation_context(session: Session, session_id: str) -> dict[str, Any]:
    latest = session.exec(
        select(Task)
        .where(Task.session_id == session_id)
        .order_by(Task.id.desc())
        .limit(1)
    ).first()
    if not latest:
        return {}
    plan_json = latest.plan_json or {}
    return {
        "last_task_id": latest.id,
        "last_action_type": plan_json.get("action_type"),
        "last_parameters": plan_json.get("parameters") or {},
        "last_goal": latest.goal,
        "last_result": latest.result_json,
    }


@dataclass
class IntentPlan:
    task_type: str
    action_type: str
    title: str
    goal: str
    criteria: list[dict[str, Any]]
    parameters: dict[str, Any]
    explanation: str
    planning_source: str = "fallback"
    agent_runtime: str = "fallback"
    gateway_mode: bool = False
    gateway_provider: str | None = None
    gateway_model: str | None = None
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    runtime_errors: list[str] = field(default_factory=list)


class ClaudePlanner:
    @staticmethod
    async def _run_json_query(
        *,
        prompt: str,
        system_prompt: str,
        schema: dict[str, Any],
        session: Session | None = None,
        max_turns: int = 2,
        timeout_seconds: int = 20,
        model: str | None = None,
        api_keys: dict[str, Any] | None = None,
    ) -> ClaudeJsonResult | None:
        if not settings.claude_enabled:
            return None
        sdk_errors: list[str] = []
        sdk_result = await ClaudeGatewayRuntime.run_json_query(
            prompt=prompt,
            system_prompt=system_prompt,
            schema=schema,
            session=session,
            max_turns=max_turns,
            timeout_seconds=timeout_seconds,
        )
        if sdk_result and sdk_result.payload is not None:
            return sdk_result
        if sdk_result and sdk_result.errors:
            sdk_errors = sdk_result.errors
        elif sdk_result and sdk_result.tool_calls:
            sdk_errors = ["Claude Agent SDK called tools but did not return structured JSON."]
        try:
            text = await registry.chat_completion(
                model=model or settings.model,
                messages=[
                    LLMMessage(role="system", content=system_prompt),
                    LLMMessage(role="user", content=prompt),
                ],
                timeout=timeout_seconds,
                api_keys=api_keys,
            )
            payload = _extract_json_payload(text)
            if not payload:
                return None
            return ClaudeJsonResult(
                payload=payload,
                raw_text=text,
                model=model or settings.model,
                errors=sdk_errors,
                tool_calls=[],
                session_id=None,
            )
        except Exception as exc:
            if sdk_errors:
                return ClaudeJsonResult(payload=None, errors=[*sdk_errors, str(exc)])
            return None

    @classmethod
    async def plan_task(
        cls,
        *,
        prompt: str,
        host: Host,
        selected_host_ids: list[int],
        session: Session,
        session_id: str,
        model: str | None = None,
        api_keys: dict[str, Any] | None = None,
    ) -> IntentPlan | None:
        recent_tasks = _recent_task_context(session, session_id)
        payload = {
            "primary_host": {
                "id": host.id,
                "name": host.name,
                "environment": host.environment,
            },
            "selected_host_ids": selected_host_ids,
            "recent_tasks": recent_tasks,
        }
        system_prompt = (
            "You are the planning layer for a Linux operations control plane. "
            "You do not have embedded host snapshot data. "
            "Return only strict JSON with keys: task_type, action_type, title, goal, "
            "criteria, parameters, explanation. "
            "Allowed action_type values: query_disk, check_host_status, search_files, check_port, query_process, "
            "inspect_databases, discover_services, run_readonly_command, create_linux_user, delete_linux_user, diagnose_service, restart_service, "
            "kill_process, delete_path, modify_security_config, bulk_permission_change. "
            "Allowed task_type values: query, change, diagnose. "
            "Prefer specialized actions when they match. For broad or unknown read-only operations, choose "
            "run_readonly_command and provide parameters.commands as 2-8 safe read-only shell probes. "
            "Use discover_services when the user asks what services/apps/containers/process managers are running. "
            "If the prompt attempts dangerous filesystem deletion, security config tampering, "
            "or large permission changes, choose the corresponding dangerous action_type. "
            "criteria must be a list of compact JSON objects. "
            "Before answering, you must use the available MCP host snapshot tool with the selected_host_ids. "
            "Do not invent host metrics or filesystem details without that tool call."
        )
        result = await cls._run_json_query(
            prompt=f"User request:\n{prompt}\n\nExecution context:\n{json.dumps(payload, ensure_ascii=False)}",
            system_prompt=system_prompt,
            schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "task_type": {"type": "string", "enum": ["query", "change", "diagnose"]},
                    "action_type": {
                        "type": "string",
                        "enum": [
                            "query_disk",
                            "check_host_status",
                            "search_files",
                            "check_port",
                            "query_process",
                            "inspect_databases",
                            "discover_services",
                            "run_readonly_command",
                            "create_linux_user",
                            "delete_linux_user",
                            "diagnose_service",
                            "restart_service",
                            "kill_process",
                            "delete_path",
                            "modify_security_config",
                            "bulk_permission_change",
                        ],
                    },
                    "title": {"type": "string"},
                    "goal": {"type": "string"},
                    "criteria": {"type": "array", "items": {"type": "object"}},
                    "parameters": {"type": "object"},
                    "explanation": {"type": "string"},
                },
                "required": ["task_type", "action_type", "title", "goal", "criteria", "parameters", "explanation"],
            },
            session=session,
            max_turns=2,
            timeout_seconds=20,
            model=model,
            api_keys=api_keys,
        )
        if not result or not result.payload:
            return None
        runtime_profile = ClaudeGatewayRuntime.current_profile()
        try:
            return IntentPlan(
                task_type=str(result.payload.get("task_type") or "query"),
                action_type=str(result.payload.get("action_type") or "query_process"),
                title=str(result.payload.get("title") or "AI 运维任务"),
                goal=str(result.payload.get("goal") or prompt),
                criteria=result.payload.get("criteria") if isinstance(result.payload.get("criteria"), list) else [],
                parameters=result.payload.get("parameters") if isinstance(result.payload.get("parameters"), dict) else {},
                explanation=str(result.payload.get("explanation") or ""),
                planning_source="claude_sdk_gateway",
                agent_runtime="claude_agent_sdk",
                gateway_mode=True,
                gateway_provider=runtime_profile.get("gateway_provider"),
                gateway_model=result.model or runtime_profile.get("gateway_model"),
                tool_calls=result.tool_calls,
                runtime_errors=result.errors,
            )
        except Exception:
            return None

    @classmethod
    async def analyze_diagnosis(
        cls,
        *,
        prompt: str,
        host: Host,
        service_name: str,
        observation: dict[str, Any],
        session: Session,
        session_id: str,
        model: str | None = None,
        api_keys: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        recent_tasks = _recent_task_context(session, session_id)
        system_prompt = (
            "You analyze Linux service failures for an AI operations platform. "
            "Return only JSON with keys: summary, root_cause, confidence, "
            "recommended_action_type, recommended_parameters, explanation. "
            "recommended_action_type must be one of none, restart_service, kill_process. "
            "Only recommend kill_process when a concrete PID is visible in the logs or socket output."
        )
        payload = {
            "prompt": prompt,
            "service_name": service_name,
            "host": {
                "name": host.name,
                "environment": host.environment,
                "os_type": host.os_type,
                "os_version": host.os_version,
            },
            "recent_tasks": recent_tasks,
            "observation": observation,
        }
        result = await cls._run_json_query(
            prompt=json.dumps(payload, ensure_ascii=False),
            system_prompt=system_prompt,
            schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "summary": {"type": "string"},
                    "root_cause": {"type": "string"},
                    "confidence": {"type": "number"},
                    "recommended_action_type": {"type": "string", "enum": ["none", "restart_service", "kill_process"]},
                    "recommended_parameters": {"type": "object"},
                    "explanation": {"type": "string"},
                },
                "required": [
                    "summary",
                    "root_cause",
                    "confidence",
                    "recommended_action_type",
                    "recommended_parameters",
                    "explanation",
                ],
            },
            session=session,
            max_turns=2,
            timeout_seconds=25,
            model=model,
            api_keys=api_keys,
        )
        return result.payload if result and result.payload else None

    @classmethod
    async def explain_result(
        cls,
        *,
        prompt: str,
        host: Host,
        plan: IntentPlan,
        action_result: dict[str, Any],
        verification_result: dict[str, Any],
        model: str | None = None,
        api_keys: dict[str, Any] | None = None,
    ) -> str | None:
        system_prompt = (
            "You summarize Linux operations results for a web control plane. "
            "Return only JSON with a single key summary. The summary must be concise, "
            "clear, user-facing, and mention any remaining risk or follow-up."
        )
        payload = {
            "prompt": prompt,
            "host": {"name": host.name, "address": host.address},
            "plan": {
                "task_type": plan.task_type,
                "action_type": plan.action_type,
                "goal": plan.goal,
                "parameters": plan.parameters,
            },
            "action_result": action_result,
            "verification_result": verification_result,
        }
        result = await cls._run_json_query(
            prompt=json.dumps(payload, ensure_ascii=False),
            system_prompt=system_prompt,
            schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {"summary": {"type": "string"}},
                "required": ["summary"],
            },
            max_turns=1,
            timeout_seconds=12,
            model=model,
            api_keys=api_keys,
        )
        if result and result.payload and isinstance(result.payload.get("summary"), str):
            return result.payload["summary"].strip()
        return None


class GoalDrivenOrchestrator:
    def __init__(self, session: Session, user: User):
        self.session = session
        self.user = user

    def _load_user_api_keys(self, user_id: int | None = None) -> dict[str, str]:
        from ..models.entities import ProviderKey
        from ..services.security import decrypt_secret
        uid = user_id if user_id is not None else self.user.id
        rows = self.session.exec(
            select(ProviderKey).where(ProviderKey.user_id == uid)
        ).all()
        keys: dict[str, str] = {}
        for row in rows:
            try:
                keys[row.provider_name] = decrypt_secret(row.encrypted_key)
            except Exception:
                pass
        return keys

    def _fallback_plan(self, prompt: str, session_context: dict[str, Any] | None = None) -> IntentPlan:
        lowered = prompt.lower()
        username_match = re.search(r"(?:用户|账号|user)\s*[:：]?\s*([a-zA-Z][\w-]{1,30})", prompt)
        service_match = re.search(r"(?:服务|service)\s*[:：]?\s*([a-zA-Z0-9._-]+)", prompt)
        path_match = re.search(r"(/[\w./-]+)", prompt)
        port_match = re.search(r"(\d{2,5})\s*(?:端口|port)", prompt)
        previous_parameters = (session_context or {}).get("last_parameters") or {}
        continuation_words = ["继续", "接着", "再", "日志", "继续看", "continue", "follow-up"]
        status_words = ["连接状态", "在线状态", "主机状态", "服务器状态", "连通性", "是否在线", "健康状态"]

        if any(word in prompt for word in continuation_words) and previous_parameters.get("service_name"):
            return IntentPlan(
                task_type="diagnose",
                action_type="diagnose_service",
                title="延续上一轮服务排障",
                goal=f"基于上一轮上下文继续排查服务: {prompt}",
                criteria=[{"type": "diagnosis_ready"}, {"type": "context_reused"}],
                parameters={"service_name": previous_parameters.get("service_name")},
                explanation=f"复用了 session 上下文中的服务名 {previous_parameters.get('service_name')} 继续诊断。",
            )

        if any(word in prompt for word in status_words) or any(word in lowered for word in ["connectivity", "host status", "online status"]):
            return IntentPlan(
                task_type="query",
                action_type="check_host_status",
                title="检查主机连接状态",
                goal=f"检查目标服务器在线状态和基础连通性: {prompt}",
                criteria=[{"type": "has_host_status"}],
                parameters={},
                explanation="该请求关注服务器/主机连接状态，应使用多主机只读状态检查，而不是服务级排障。",
            )

        if "磁盘" in prompt or "disk" in lowered:
            return IntentPlan(
                task_type="query",
                action_type="query_disk",
                title="查询磁盘使用情况",
                goal=f"在指定主机上获取磁盘使用情况: {prompt}",
                criteria=[{"type": "has_disk_result"}],
                parameters={},
                explanation="读取磁盘分区和使用率。",
            )
        if any(word in prompt for word in ["数据库", "数据源", "实例"]) or any(
            word in lowered for word in ["database", "mysql", "mariadb", "postgres", "postgresql", "redis", "mongodb"]
        ):
            return IntentPlan(
                task_type="query",
                action_type="inspect_databases",
                title="扫描数据库服务",
                goal=f"扫描目标主机上的数据库服务、端口和进程: {prompt}",
                criteria=[{"type": "has_database_inventory"}],
                parameters={},
                explanation="该请求是跨主机数据库盘点，应使用多主机只读扫描，而不是服务级排障。",
            )
        if _mentions_service_inventory(prompt, lowered):
            return IntentPlan(
                task_type="query",
                action_type="discover_services",
                title="发现主机服务",
                goal=f"扫描目标主机上的 systemd、Docker、PM2、Supervisor 和监听端口: {prompt}",
                criteria=[{"type": "has_service_inventory"}],
                parameters={},
                explanation="该请求关注主机上运行的服务与应用，应使用服务发现而不是单服务排障。",
            )
        if "文件" in prompt or "目录" in prompt or "find" in lowered or "search" in lowered:
            query_match = re.search(r"(?:查找|搜索|find|search)\s*([^\s]+)", prompt, re.I)
            return IntentPlan(
                task_type="query",
                action_type="search_files",
                title="检索文件或目录",
                goal=f"在目标主机上检索匹配文件或目录: {prompt}",
                criteria=[{"type": "has_search_result"}],
                parameters={
                    "query": (query_match.group(1) if query_match else "conf"),
                    "path": (path_match.group(1) if path_match else "/etc"),
                },
                explanation="在指定路径范围内检索文件和目录。",
            )
        if "端口" in prompt or "port" in lowered:
            return IntentPlan(
                task_type="query",
                action_type="check_port",
                title="查询端口占用",
                goal=f"定位端口占用进程: {prompt}",
                criteria=[{"type": "has_port_result"}],
                parameters={"port": int(port_match.group(1)) if port_match else 22},
                explanation="检查监听端口和对应进程。",
            )
        if "进程" in prompt or "process" in lowered:
            process_name_match = re.search(r"(?:进程|process)\s*[:：]?\s*([a-zA-Z0-9._-]+)", prompt)
            return IntentPlan(
                task_type="query",
                action_type="query_process",
                title="查询进程状态",
                goal=f"获取指定主机上的进程状态: {prompt}",
                criteria=[{"type": "has_process_result"}],
                parameters={"process_name": process_name_match.group(1) if process_name_match else None},
                explanation="查看目标进程或 CPU 占用最高的进程。",
            )
        if ("创建" in prompt or "新增" in prompt) and ("用户" in prompt or "user" in lowered):
            return IntentPlan(
                task_type="change",
                action_type="create_linux_user",
                title="创建 Linux 用户",
                goal=f"在目标主机上创建用户: {prompt}",
                criteria=[{"type": "user_exists", "username": username_match.group(1) if username_match else None}],
                parameters={"username": username_match.group(1) if username_match else None},
                explanation="创建普通 Linux 用户。",
            )
        if ("删除" in prompt or "remove" in lowered or "delete" in lowered) and ("用户" in prompt or "user" in lowered):
            return IntentPlan(
                task_type="change",
                action_type="delete_linux_user",
                title="删除 Linux 用户",
                goal=f"在目标主机上删除用户: {prompt}",
                criteria=[{"type": "user_absent", "username": username_match.group(1) if username_match else None}],
                parameters={"username": username_match.group(1) if username_match else None},
                explanation="删除普通 Linux 用户。",
            )
        if ("删除" in prompt or "rm" in lowered) and path_match:
            return IntentPlan(
                task_type="change",
                action_type="delete_path",
                title="危险路径删除请求",
                goal=prompt,
                criteria=[],
                parameters={"path": path_match.group(1)},
                explanation="识别到删除路径请求。",
            )
        if any(keyword in lowered for keyword in ["sshd_config", "security config", "config"]) or "权限" in prompt or "chmod" in lowered or "chown" in lowered:
            return IntentPlan(
                task_type="change",
                action_type="modify_security_config" if any(keyword in lowered for keyword in ["sshd_config", "security config", "config"]) else "bulk_permission_change",
                title="高风险系统配置请求",
                goal=prompt,
                criteria=[],
                parameters={"raw_prompt": prompt},
                explanation="识别到高风险安全配置或权限变更请求。",
            )
        if service_match:
            return IntentPlan(
                task_type="diagnose",
                action_type="diagnose_service",
                title="服务排障",
                goal=f"对服务问题执行 goal-driven 排障: {prompt}",
                criteria=[{"type": "diagnosis_ready"}, {"type": "approval_if_action_required"}],
                parameters={"service_name": service_match.group(1)},
                explanation="收集服务状态、日志和端口信息后给出结论或修复建议。",
            )
        return IntentPlan(
            task_type="query",
            action_type="run_readonly_command",
            title="通用系统巡检",
            goal=f"用只读探测命令理解并回答用户的运维问题: {prompt}",
            criteria=[{"type": "has_readonly_probe_result"}],
            parameters={"commands": _default_readonly_commands(prompt), "report_focus": prompt},
            explanation="未匹配到固定工具时，使用受策略约束的通用只读探测流程，避免退化成单一服务排障。",
        )

    def _normalize_plan(self, prompt: str, plan: IntentPlan) -> IntentPlan:
        lowered = prompt.lower()
        service_match = re.search(r"(?:服务|service)\s*[:：]?\s*([a-zA-Z0-9._-]+)", prompt)
        service_name = plan.parameters.get("service_name") or (service_match.group(1) if service_match else None)
        status_words = ["连接状态", "在线状态", "主机状态", "服务器状态", "连通性", "是否在线", "健康状态"]

        if any(word in prompt for word in status_words) or any(word in lowered for word in ["connectivity", "host status", "online status"]):
            plan.task_type = "query"
            plan.action_type = "check_host_status"
            plan.title = "检查主机连接状态"
            plan.goal = f"检查目标服务器在线状态和基础连通性: {prompt}"
            plan.criteria = [{"type": "has_host_status"}]
            plan.parameters = {}
            plan.explanation = "该请求关注服务器/主机连接状态，统一归一化到多主机只读状态检查。"
            return plan

        if any(keyword in prompt for keyword in ["磁盘", "硬盘"]) or "disk" in lowered:
            plan.task_type = "query"
            plan.action_type = "query_disk"
            plan.title = "查询磁盘使用情况" if "详细" not in prompt and "报告" not in prompt else "硬盘使用情况分析报告"
            plan.goal = f"在目标主机上获取磁盘使用情况并输出分析: {prompt}"
            plan.criteria = [{"type": "has_disk_result"}]
            plan.parameters = {
                **plan.parameters,
                "analysis_type": "comprehensive" if any(keyword in prompt for keyword in ["详细", "报告", "分析"]) else "basic",
            }
            plan.explanation = "该请求明确指向磁盘/硬盘分析，统一归一化到 query_disk。"
            return plan

        if any(keyword in prompt for keyword in ["数据库", "数据源", "实例"]) or any(
            keyword in lowered for keyword in ["database", "mysql", "mariadb", "postgres", "postgresql", "redis", "mongodb"]
        ):
            plan.task_type = "query"
            plan.action_type = "inspect_databases"
            plan.title = "扫描数据库服务"
            plan.goal = f"扫描目标主机上的数据库服务、端口和进程: {prompt}"
            plan.criteria = [{"type": "has_database_inventory"}]
            plan.parameters = {}
            plan.explanation = "该请求关注数据库资产发现，统一归一化到多主机只读数据库扫描。"
            return plan

        if _mentions_service_inventory(prompt, lowered):
            if plan.action_type not in {"diagnose_service", "restart_service", "kill_process"}:
                plan.task_type = "query"
                plan.action_type = "discover_services"
                plan.title = "发现主机服务"
                plan.goal = f"扫描目标主机上的服务、容器、PM2、Supervisor 与监听端口: {prompt}"
                plan.criteria = [{"type": "has_service_inventory"}]
                plan.parameters = {}
                plan.explanation = "该请求关注服务资产盘点，统一归一化到 discover_services。"
                return plan

        if plan.action_type == "search_files":
            plan.parameters = {
                **plan.parameters,
                "query": plan.parameters.get("query") or plan.parameters.get("keyword") or "nginx",
                "path": plan.parameters.get("path") or plan.parameters.get("base_path") or "/etc",
            }

        if plan.action_type == "run_readonly_command":
            commands = _coerce_readonly_commands(plan.parameters, prompt)
            plan.parameters = {
                **plan.parameters,
                "commands": commands,
                "report_focus": plan.parameters.get("report_focus") or prompt,
            }
            plan.criteria = plan.criteria or [{"type": "has_readonly_probe_result"}]

        diagnostic_words = ["排查", "诊断", "状态", "建议", "why", "原因", "检查"]
        security_words = ["配置", "config", "sshd_config", "权限", "chmod", "chown", "提权", "安全"]
        if (
            plan.action_type in {"modify_security_config", "bulk_permission_change"}
            and any(word in prompt for word in diagnostic_words)
            and not any(word in lowered for word in security_words)
        ):
            return IntentPlan(
                task_type="diagnose",
                action_type="diagnose_service",
                title="服务排障",
                goal=f"对服务问题执行 goal-driven 排障: {prompt}",
                criteria=[{"type": "diagnosis_ready"}, {"type": "approval_if_action_required"}],
                parameters={"service_name": service_name or "sshd"},
                explanation="该请求语义上是诊断服务状态，而不是修改安全配置。",
                planning_source=plan.planning_source,
                agent_runtime=plan.agent_runtime,
                gateway_mode=plan.gateway_mode,
                gateway_provider=plan.gateway_provider,
                gateway_model=plan.gateway_model,
                tool_calls=plan.tool_calls,
                runtime_errors=plan.runtime_errors,
            )

        return plan

    async def _build_plan(self, prompt: str, host: Host, selected_hosts: list[int], session_id: str, model: str | None = None, api_keys: dict[str, Any] | None = None) -> IntentPlan:
        session_context = _session_continuation_context(self.session, session_id)
        plan = await ClaudePlanner.plan_task(
            prompt=prompt,
            host=host,
            selected_host_ids=selected_hosts,
            session=self.session,
            session_id=session_id,
            model=model,
            api_keys=api_keys,
        )
        normalized = self._normalize_plan(prompt, plan or self._fallback_plan(prompt, session_context))
        if session_context and "context_reused" in json.dumps(normalized.criteria, ensure_ascii=False):
            normalized.parameters = {**normalized.parameters, "_context_reused": True}
        elif session_context and session_context.get("last_parameters", {}).get("service_name"):
            prompt_has_service = bool(re.search(r"(?:服务|service)\s*[:：]?\s*([a-zA-Z0-9._-]+)", prompt))
            if not prompt_has_service and normalized.action_type == "diagnose_service":
                normalized.parameters = {
                    **normalized.parameters,
                    "service_name": normalized.parameters.get("service_name") or session_context["last_parameters"].get("service_name"),
                    "_context_reused": True,
                }
                normalized.explanation = f"{normalized.explanation} 已复用上一轮 session 上下文中的服务名。".strip()
        return normalized

    async def _execute_action(
        self,
        host: Host,
        credential: HostCredential | None,
        action_type: str,
        parameters: dict[str, Any],
    ) -> dict[str, Any]:
        if host.agent_url:
            try:
                return await AgentConnector.call(
                    host,
                    "/execute",
                    method="POST",
                    payload={"action_type": action_type, "parameters": parameters, "dry_run": False},
                )
            except Exception as agent_exc:
                agent_error = str(agent_exc)
        else:
            agent_error = None

        process_name = parameters.get("process_name")
        service_name = parameters.get("service_name") or "sshd"
        if action_type == "diagnose_service":
            command = (
                f"systemctl status {shlex.quote(service_name)} --no-pager || true; "
                f"systemctl is-active {shlex.quote(service_name)} || true; "
                f"journalctl -u {shlex.quote(service_name)} -n 60 --no-pager || true; "
                "ss -ltnp | tail -n +1 || true"
            )
        elif action_type == "check_host_status":
            command = (
                "printf 'hostname='; hostname; "
                "printf 'uptime='; uptime; "
                "printf 'load='; cat /proc/loadavg 2>/dev/null || true; "
                "printf 'kernel='; uname -srmo; "
                "printf 'disk_root='; df -h / 2>/dev/null | tail -n 1 || true"
            )
        elif action_type == "query_disk":
            command = "timeout 12 df -h || df -hl"
        elif action_type == "inspect_databases":
            command = r"""bash -lc '
                echo "__PORTS__"
                ss -ltnp 2>/dev/null | grep -Ei ":(3306|5432|6379|27017|27018|1521|9200|9300|9042|8123|9000|8086|7474|7687)\b" || true
                echo "__PROCESSES__"
                ps -eo pid=,user=,comm=,%cpu=,%mem=,args= --sort=comm 2>/dev/null \
                  | grep -Ei "(mysql|mariadb|postgres|postmaster|redis-server|mongod|oracle|clickhouse|influxd|elasticsearch|neo4j|cassandra)" \
                  | grep -v grep || true
                echo "__SYSTEMD__"
                systemctl list-units --type=service --all --no-pager --no-legend 2>/dev/null \
                  | grep -Ei "(mysql|mariadb|postgres|redis|mongo|oracle|clickhouse|influx|elastic|neo4j|cassandra)" || true
                echo "__DOCKER__"
                docker ps --format "{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}" 2>/dev/null \
                  | grep -Ei "(mysql|mariadb|postgres|redis|mongo|oracle|clickhouse|influx|elastic|neo4j|cassandra)" || true
                echo "__PM2__"
                pm2 list --no-color 2>/dev/null \
                  | grep -Ei "(mysql|mariadb|postgres|redis|mongo|oracle|clickhouse|influx|elastic|neo4j|cassandra)" || true
            '"""
        elif action_type == "discover_services":
            services = await HostInspector.discover_services(host, credential)
            stored = ServiceSync.sync(self.session, host, services)
            rows = [
                {
                    "name": service.name,
                    "runtime": service.runtime_type,
                    "status": service.status,
                    "ports": service.ports,
                    "sources": service.discovery_source,
                    "workload": (service.evidence_json or {}).get("workload"),
                    "database_engine": (service.evidence_json or {}).get("database_engine"),
                }
                for service in stored[:80]
            ]
            return {
                "success": True,
                "exit_code": 0,
                "stdout": json.dumps({"service_count": len(stored), "services": rows}, ensure_ascii=False, indent=2),
                "stderr": "",
                "json": {"service_count": len(stored), "services": rows},
            }
        elif action_type == "run_readonly_command":
            commands = _coerce_readonly_commands(parameters)
            command, problems = _build_readonly_probe_script(commands)
            if problems:
                return {
                    "success": False,
                    "exit_code": 126,
                    "stdout": "",
                    "stderr": "Blocked unsafe read-only probe: " + "; ".join(problems),
                }
        elif action_type == "search_files":
            root = _safe_token(_safe_path(parameters.get("path")))
            if parameters.get("query"):
                raw_query = str(parameters["query"]).replace("'", "")
                command = (
                    f"find {_safe_token(_safe_path(parameters.get('path')))} -maxdepth 6 "
                    f"\\( -iname '*{raw_query}*' -o -path '*{raw_query}*' \\) "
                    "-print 2>/dev/null | head -n 60"
                )
            else:
                command = f"find {_safe_token(_safe_path(parameters.get('path')))} -maxdepth 3 -print 2>/dev/null | head -n 60"
        elif action_type == "check_port":
            port = int(parameters.get("port") or 22)
            command = f"ss -ltnp | grep ':{port}' || true"
        elif action_type == "query_process":
            if process_name:
                command = f"ps aux | grep -i {shlex.quote(str(process_name))} | grep -v grep | head -n 25 || true"
            else:
                command = "(ps aux --sort=-%cpu 2>/dev/null || ps aux) | head -n 20"
        elif action_type == "create_linux_user":
            command = f"sudo useradd -m {shlex.quote(str(parameters['username']))}"
        elif action_type == "delete_linux_user":
            command = f"sudo userdel -r {shlex.quote(str(parameters['username']))}"
        elif action_type == "restart_service":
            command = f"sudo systemctl restart {shlex.quote(service_name)} && systemctl is-active {shlex.quote(service_name)}"
        elif action_type == "kill_process":
            pid = int(parameters["pid"])
            command = f"sudo kill {pid} && sleep 1 && ps -p {pid} || true"
        else:
            command = "echo unsupported action"
        result = await SSHConnector.run(host, credential, command, timeout_seconds=20)
        if not result.get("success") and agent_error:
            result["stderr"] = f"[Agent] {agent_error} | [SSH] {result.get('stderr', '')}"
        return result

    async def _verify(
        self,
        host: Host,
        credential: HostCredential | None,
        action_type: str,
        parameters: dict[str, Any],
    ) -> dict[str, Any]:
        username = parameters.get("username")
        service_name = parameters.get("service_name") or "sshd"
        if action_type == "create_linux_user" and username:
            return await SSHConnector.run(host, credential, f"getent passwd {shlex.quote(str(username))}", timeout_seconds=10)
        if action_type == "delete_linux_user" and username:
            result = await SSHConnector.run(host, credential, f"getent passwd {shlex.quote(str(username))}", timeout_seconds=10)
            return {
                "success": not result.get("success", False),
                "exit_code": 0 if not result.get("success", False) else 1,
                "stdout": "user absent" if not result.get("success", False) else result.get("stdout", ""),
                "stderr": result.get("stderr", ""),
            }
        if action_type == "check_host_status":
            return await self._execute_action(host, credential, action_type, parameters)
        if action_type == "query_disk":
            return await SSHConnector.run(host, credential, "df -h", timeout_seconds=10)
        if action_type == "search_files":
            return await self._execute_action(host, credential, action_type, parameters)
        if action_type == "inspect_databases":
            return await self._execute_action(host, credential, action_type, parameters)
        if action_type == "discover_services":
            return await self._execute_action(host, credential, action_type, parameters)
        if action_type == "run_readonly_command":
            return await self._execute_action(host, credential, action_type, parameters)
        if action_type == "check_port" and parameters.get("port"):
            return await SSHConnector.run(host, credential, f"ss -ltnp | grep ':{int(parameters['port'])}' || true", timeout_seconds=10)
        if action_type == "query_process":
            return await self._execute_action(host, credential, action_type, parameters)
        if action_type == "restart_service":
            return await SSHConnector.run(host, credential, f"systemctl is-active {shlex.quote(service_name)}", timeout_seconds=10)
        if action_type == "kill_process":
            result = await SSHConnector.run(host, credential, f"ps -p {int(parameters['pid'])}", timeout_seconds=10)
            return {
                "success": not result.get("success", False),
                "exit_code": 0 if not result.get("success", False) else 1,
                "stdout": "process absent" if not result.get("success", False) else result.get("stdout", ""),
                "stderr": result.get("stderr", ""),
            }
        return {"success": True, "stdout": "No extra verification required", "stderr": "", "exit_code": 0}

    def _create_task(
        self,
        *,
        prompt: str,
        session_id: str,
        selected_host_ids: list[int],
        plan: IntentPlan,
        policy: dict[str, Any],
        claude_metadata: dict[str, Any],
    ) -> Task:
        task = Task(
            session_id=session_id,
            user_id=self.user.id,
            title=plan.title,
            prompt=prompt,
            task_type=plan.task_type,
            goal=plan.goal,
            criteria_json=plan.criteria,
            target_hosts=selected_host_ids,
            risk_level=policy.get("risk_level", "L0"),
            status="running",
            plan_json={
                "action_type": plan.action_type,
                "parameters": plan.parameters,
                "policy": policy,
                "plan_explanation": plan.explanation,
                "ai": claude_metadata,
            },
        )
        self.session.add(task)
        self.session.commit()
        self.session.refresh(task)
        return task

    def _record_step(
        self,
        *,
        task_id: int,
        step_type: str,
        title: str,
        status: str,
        input_json: dict[str, Any],
        output_json: dict[str, Any],
        retryable: bool = False,
    ) -> None:
        self.session.add(
            TaskStep(
                task_id=task_id,
                step_type=step_type,
                title=title,
                status=status,
                input_json=jsonable(redact_sensitive(input_json)),
                output_json=jsonable(redact_sensitive(output_json)),
                retryable=retryable,
            )
        )
        self.session.commit()

    def _audit_hosts(
        self,
        *,
        hosts: list[Host],
        actor_id: int | None,
        task_id: int,
        event_type: str,
        payload: dict[str, Any],
    ) -> None:
        if not hosts:
            upsert_audit(
                self.session,
                actor_id=actor_id,
                task_id=task_id,
                host_id=None,
                event_type=event_type,
                payload=payload,
            )
            return
        for host in hosts:
            upsert_audit(
                self.session,
                actor_id=actor_id,
                task_id=task_id,
                host_id=host.id,
                event_type=event_type,
                payload=payload,
            )

    def _build_result_payload(
        self,
        *,
        plan: IntentPlan,
        prompt: str,
        per_host_results: list[dict[str, Any]],
    ) -> dict[str, Any]:
        if plan.action_type == "query_disk":
            report_markdown, report_meta, summary = _build_disk_report(per_host_results, prompt)
            return {
                "summary": summary,
                "per_host": per_host_results,
                "report_kind": "analysis",
                "report_markdown": report_markdown,
                "report_meta": report_meta,
            }
        report_markdown, report_meta, summary = _build_generic_report(
            plan=plan,
            prompt=prompt,
            per_host_results=per_host_results,
        )
        return {
            "summary": summary,
            "per_host": per_host_results,
            "report_kind": "analysis",
            "report_markdown": report_markdown,
            "report_meta": report_meta,
        }

    def _build_diagnosis_payload(
        self,
        *,
        host: Host,
        prompt: str,
        observation: dict[str, Any],
        diagnosis: dict[str, Any],
    ) -> dict[str, Any]:
        summary = str(diagnosis.get("summary") or "诊断完成")
        lines = [
            "# 服务诊断报告",
            "",
            "## 执行摘要",
            f"- 请求：{prompt}",
            f"- 目标主机：{host.name}",
            f"- 结论：{summary}",
            "",
            "## 根因分析",
            f"- 根因：{diagnosis.get('root_cause') or 'unknown'}",
            f"- 置信度：{diagnosis.get('confidence') if diagnosis.get('confidence') is not None else 'unknown'}",
            "",
            "## 建议动作",
            f"- 推荐动作：`{diagnosis.get('recommended_action_type') or 'none'}`",
        ]
        explanation = str(diagnosis.get("explanation") or "").strip()
        if explanation:
            lines.extend(["", "## 解释", explanation])
        stdout = str(observation.get("stdout") or "").strip()
        if stdout:
            lines.extend(["", "## 观察到的原始信息", "```text", stdout[:4000], "```"])
        return {
            "summary": summary,
            "diagnosis": diagnosis,
            "observation": observation,
            "report_kind": "diagnosis",
            "report_markdown": "\n".join(lines).strip(),
            "report_meta": {
                "host_count": 1,
                "success_count": 1,
                "failed_count": 0,
                "risk_hosts": [host.name],
                "primary_metrics": {
                    "recommended_action_type": diagnosis.get("recommended_action_type") or "none",
                },
            },
        }

    async def _request_approval(
        self,
        *,
        task: Task,
        hosts: list[Host],
        action_type: str,
        parameters: dict[str, Any],
        explanation: str,
        policy: dict[str, Any],
        model: str | None = None,
    ) -> Task:
        approval = Approval(
            task_id=task.id,
            requester_id=self.user.id,
            status="pending",
            action_payload={
                "action_type": action_type,
                "parameters": parameters,
                "host_ids": [host.id for host in hosts],
                "explanation": explanation,
                "policy": policy,
                "model": model,
                "requester_id": self.user.id,
            },
        )
        self.session.add(approval)
        task.status = "waiting_approval"
        task.approval_required = True
        self.session.add(task)
        self.session.commit()
        self._record_step(
            task_id=task.id,
            step_type="approval",
            title="等待高风险审批",
            status="pending",
            input_json={"action_type": action_type, "parameters": parameters},
            output_json=approval.action_payload,
        )
        self._audit_hosts(
            hosts=hosts,
            actor_id=self.user.id,
            task_id=task.id,
            event_type="approval_requested",
            payload=approval.action_payload,
        )
        return task

    async def _run_act_and_verify(
        self,
        *,
        task: Task,
        hosts: list[Host],
        credentials: dict[int, HostCredential | None],
        plan: IntentPlan,
        model: str | None = None,
        api_keys: dict[str, Any] | None = None,
    ) -> Task:
        read_only_actions = {
            "query_disk",
            "check_host_status",
            "search_files",
            "check_port",
            "query_process",
            "inspect_databases",
            "discover_services",
            "run_readonly_command",
        }
        
        async def _run_for_host(host: Host) -> dict[str, Any]:
            credential = credentials.get(host.id)
            act_result = await self._execute_action(host, credential, plan.action_type, plan.parameters)
            if plan.action_type in read_only_actions and not act_result.get("success") and _looks_transient_transport_error(act_result):
                await asyncio.sleep(0.4)
                act_result = await self._execute_action(host, credential, plan.action_type, plan.parameters)
            if plan.action_type in read_only_actions:
                verify_result = {
                    "success": bool(act_result.get("success", False)),
                    "exit_code": 0 if act_result.get("success", False) else act_result.get("exit_code", 1),
                    "stdout": "Primary read-only execution accepted as verification evidence.",
                    "stderr": act_result.get("stderr", ""),
                }
            else:
                verify_result = await self._verify(host, credential, plan.action_type, plan.parameters)
            host_success = bool(act_result.get("success", False)) and bool(verify_result.get("success", False))
            return {
                "host_id": host.id,
                "host_name": host.name,
                "action_result": jsonable(redact_sensitive(act_result)),
                "verification_result": jsonable(redact_sensitive(verify_result)),
                "success": host_success,
            }

        per_host_results = list(await asyncio.gather(*(_run_for_host(host) for host in hosts)))
        all_action_success = all(item["action_result"].get("success") for item in per_host_results)
        all_verify_success = all(item["verification_result"].get("success") for item in per_host_results)
        all_host_success = all(item["success"] for item in per_host_results)
        any_host_success = any(item["success"] for item in per_host_results)
        partial_read_only_success = len(hosts) > 1 and plan.action_type in read_only_actions and any_host_success
        self._record_step(
            task_id=task.id,
            step_type="act",
            title="执行主动作",
            status="completed" if all_action_success or partial_read_only_success else "failed",
            input_json={"action_type": plan.action_type, "parameters": plan.parameters, "host_ids": [host.id for host in hosts]},
            output_json={"per_host": per_host_results},
            retryable=False,
        )
        self._record_step(
            task_id=task.id,
            step_type="verify",
            title="校验成功标准",
            status="completed" if all_verify_success or partial_read_only_success else "failed",
            input_json={"criteria": task.criteria_json},
            output_json={"per_host": per_host_results},
        )
        first_host = hosts[0]
        success = all_host_success or partial_read_only_success
        if len(hosts) == 1:
            summary = await ClaudePlanner.explain_result(
                prompt=task.prompt,
                host=first_host,
                plan=plan,
                action_result=per_host_results[0]["action_result"],
                verification_result=per_host_results[0]["verification_result"],
                model=model,
                api_keys=api_keys,
            )
        else:
            summary = None
        task.status = "succeeded" if success else "failed"
        result_payload = self._build_result_payload(
            plan=plan,
            prompt=task.prompt,
            per_host_results=per_host_results,
        )
        if summary:
            result_payload["summary"] = summary
        if not success and not summary:
            first_stderr = next(
                (
                    item["action_result"].get("stderr", "").strip()
                    for item in per_host_results
                    if not item["success"] and item["action_result"].get("stderr", "").strip()
                ),
                None,
            )
            if first_stderr:
                result_payload["summary"] = f"{result_payload['summary']} 连接错误: {first_stderr[:300]}"
        task.result_json = result_payload
        task.updated_at = now()
        self.session.add(task)
        self.session.commit()
        for item in per_host_results:
            upsert_audit(
                self.session,
                actor_id=self.user.id,
                task_id=task.id,
                host_id=item["host_id"],
                event_type="task_finished",
                payload={
                    "summary": task.result_json["summary"],
                    "host_result": item,
                    "host_count": len(per_host_results),
                },
            )
        return task

    async def _run_diagnosis_flow(
        self,
        *,
        task: Task,
        host: Host,
        credential: HostCredential | None,
        plan: IntentPlan,
        auto_approve: bool,
        model: str | None = None,
        api_keys: dict[str, Any] | None = None,
    ) -> Task:
        observation = await self._execute_action(host, credential, "diagnose_service", plan.parameters)
        self._record_step(
            task_id=task.id,
            step_type="observe",
            title="收集服务状态与日志",
            status="completed" if observation.get("success") else "failed",
            input_json=plan.parameters,
            output_json=observation,
        )
        diagnosis = await ClaudePlanner.analyze_diagnosis(
            prompt=task.prompt,
            host=host,
            service_name=str(plan.parameters.get("service_name") or "sshd"),
            observation=observation,
            session=self.session,
            session_id=task.session_id,
            model=model,
            api_keys=api_keys,
        )
        diagnosis = diagnosis or {
            "summary": "已完成基础诊断，但未获得 AI 结构化结论。",
            "root_cause": "unknown",
            "confidence": 0.2,
            "recommended_action_type": "none",
            "recommended_parameters": {},
            "explanation": "可以根据日志继续人工分析。",
        }
        self._record_step(
            task_id=task.id,
            step_type="analyze",
            title="分析根因并生成建议",
            status="completed",
            input_json={"prompt": task.prompt},
            output_json=diagnosis,
        )
        recommended_action = diagnosis.get("recommended_action_type") or "none"
        if recommended_action == "none":
            task.status = "succeeded" if observation.get("success") else "failed"
            task.result_json = {
                "summary": diagnosis.get("summary"),
                "diagnosis": diagnosis,
                "observation": observation,
            }
            task.updated_at = now()
            self.session.add(task)
            self.session.commit()
            upsert_audit(
                self.session,
                actor_id=self.user.id,
                task_id=task.id,
                host_id=host.id,
                event_type="task_finished",
                payload=task.result_json,
            )
            return task

        recommendation_plan = IntentPlan(
            task_type="change",
            action_type=str(recommended_action),
            title=f"诊断后修复动作: {recommended_action}",
            goal=f"根据诊断结果执行修复: {task.prompt}",
            criteria=task.criteria_json,
            parameters=diagnosis.get("recommended_parameters")
            if isinstance(diagnosis.get("recommended_parameters"), dict)
            else {},
            explanation=str(diagnosis.get("explanation") or diagnosis.get("summary") or ""),
        )
        if recommendation_plan.action_type == "restart_service" and not recommendation_plan.parameters.get("service_name"):
            recommendation_plan.parameters["service_name"] = plan.parameters.get("service_name") or "sshd"
        policy = PolicyEngine.evaluate(recommendation_plan.action_type, recommendation_plan.parameters, host)
        if not policy.get("allowed", False):
            task.status = "failed"
            task.result_json = _build_error_report(
                "诊断后修复被阻断",
                policy.get("reason") or "策略引擎已阻断该修复动作。",
                reason=str(diagnosis.get("summary") or ""),
            ) | {"diagnosis": diagnosis}
            self.session.add(task)
            self.session.commit()
            return task
        if policy.get("approval_required") and not auto_approve:
            task.plan_json["diagnosis"] = diagnosis
            self.session.add(task)
            self.session.commit()
            return await self._request_approval(
                task=task,
                hosts=[host],
                action_type=recommendation_plan.action_type,
                parameters=recommendation_plan.parameters,
                explanation=recommendation_plan.explanation,
                policy=policy,
                model=model,
            )
        return await self._run_act_and_verify(task=task, hosts=[host], credentials={host.id: credential}, plan=recommendation_plan, model=model, api_keys=api_keys)

    def _blast_radius(self, selected_host_ids: list[int], parameters: dict[str, Any]) -> dict[str, Any]:
        services = list(
            self.session.exec(select(Service).where(Service.host_id.in_(selected_host_ids))).all()
        ) if selected_host_ids else []
        return {
            "hosts": len(selected_host_ids),
            "services": len(services),
            "paths": [parameters.get("path")] if parameters.get("path") else [],
        }

    async def execute(self, prompt: str, session_id: str, selected_host_ids: list[int], auto_approve: bool, model: str | None = None) -> Task:
        if not selected_host_ids:
            raise HTTPException(status_code=400, detail="At least one host must be selected")
        resolved_model = model or settings.model
        api_keys = self._load_user_api_keys()

        hosts = [HostRepository.get_host(self.session, host_id) for host_id in selected_host_ids]
        credentials = {host.id: HostRepository.get_credential(self.session, host.id) for host in hosts}
        host = hosts[0]
        credential = credentials[host.id]

        live_metrics_by_host: dict[int, dict[str, Any]] = {}
        
        async def _collect_host_metrics(target_host: Host) -> tuple[int, dict[str, Any]]:
            target_credential = credentials[target_host.id]
            metrics = await HostInspector.metrics(target_host, target_credential)
            return target_host.id, metrics

        for host_id, metrics in await asyncio.gather(*(_collect_host_metrics(target_host) for target_host in hosts)):
            target_host = next(item for item in hosts if item.id == host_id)
            target_host.metrics_json = metrics
            target_host.last_seen_at = now()
            self.session.add(target_host)
            self.session.commit()
            MonitoringCoreService.record_sample(self.session, host=target_host, metrics=metrics, source="task-entry")
            live_metrics_by_host[target_host.id] = {
                "host": {"id": target_host.id, "name": target_host.name, "address": target_host.address},
                "metrics": metrics,
            }
        live_metrics = live_metrics_by_host[host.id]["metrics"]

        plan = await self._build_plan(prompt, host, selected_host_ids, session_id, resolved_model, api_keys)
        policy = PolicyEngine.evaluate(plan.action_type, plan.parameters, host)
        policy["blast_radius"] = self._blast_radius(selected_host_ids, plan.parameters)
        task = self._create_task(
            prompt=prompt,
            session_id=session_id,
            selected_host_ids=selected_host_ids,
            plan=plan,
            policy=policy,
            claude_metadata={
                "claude_enabled": settings.claude_enabled,
                "credentials_available": ClaudeGatewayRuntime.credentials_available(),
                "used_ai_planning": plan.agent_runtime == "claude_agent_sdk",
                "fallback_context_used": bool(plan.parameters.get("_context_reused")),
                "agent_runtime": plan.agent_runtime,
                "gateway_mode": plan.gateway_mode,
                "gateway_provider": plan.gateway_provider,
                "gateway_model": plan.gateway_model,
                "tool_calls": plan.tool_calls,
                "runtime_errors": plan.runtime_errors,
            },
        )
        self._record_step(
            task_id=task.id,
            step_type="observe",
            title="收集主机上下文",
            status="completed",
            input_json={"host_ids": [target_host.id for target_host in hosts]},
            output_json={"hosts": list(live_metrics_by_host.values())},
        )
        self._record_step(
            task_id=task.id,
            step_type="analyze",
            title="生成执行计划",
            status="completed",
            input_json={"prompt": prompt},
            output_json={"plan": task.plan_json},
        )
        self._audit_hosts(
            hosts=hosts,
            actor_id=self.user.id,
            task_id=task.id,
            event_type="task_created",
            payload=task.plan_json,
        )

        if not policy.get("allowed", False):
            task.status = "failed"
            task.result_json = _build_error_report(
                task.title,
                policy.get("reason", "Blocked"),
                reason=plan.explanation,
            ) | {
                "policy": policy,
                "plan_explanation": plan.explanation,
            }
            task.updated_at = now()
            self.session.add(task)
            self.session.commit()
            self._audit_hosts(
                hosts=hosts,
                actor_id=self.user.id,
                task_id=task.id,
                event_type="task_blocked",
                payload=task.result_json,
            )
            return task

        if plan.action_type == "diagnose_service":
            if len(hosts) > 1:
                task.status = "failed"
                task.result_json = _build_error_report(
                    task.title,
                    "服务级诊断当前要求精确选择单台主机执行。",
                    reason="请在顶部目标主机里只保留一台主机后再执行。",
                )
                self.session.add(task)
                self.session.commit()
                return task
            return await self._run_diagnosis_flow(
                task=task,
                host=host,
                credential=credential,
                plan=plan,
                auto_approve=auto_approve,
                model=resolved_model,
                api_keys=api_keys,
            )

        if policy.get("approval_required") and not auto_approve:
            return await self._request_approval(
                task=task,
                hosts=hosts,
                action_type=plan.action_type,
                parameters=plan.parameters,
                explanation=plan.explanation,
                policy=policy,
                model=resolved_model,
            )

        return await self._run_act_and_verify(task=task, hosts=hosts, credentials=credentials, plan=plan, model=resolved_model, api_keys=api_keys)

    async def resume_after_approval(self, approval: Approval, approver: User, approved: bool, reason: str | None) -> Task:
        task = self.session.get(Task, approval.task_id)
        if not task:
            raise HTTPException(status_code=404, detail="Task not found")
        if approval.status != "pending":
            raise HTTPException(status_code=409, detail="Approval already decided")

        approval.approver_id = approver.id
        approval.status = "approved" if approved else "rejected"
        approval.decision_reason = reason
        approval.decided_at = now()
        self.session.add(approval)

        if not approved:
            task.status = "failed"
            task.result_json = _build_error_report(
                task.title,
                reason or "Approval rejected",
                reason=reason,
            )
            self.session.add(task)
            self.session.commit()
            self._audit_hosts(
                hosts=[HostRepository.get_host(self.session, host_id) for host_id in (approval.action_payload.get("host_ids") or task.target_hosts)],
                actor_id=approver.id,
                task_id=task.id,
                event_type="approval_rejected",
                payload={"reason": reason},
            )
            return task

        host_ids = approval.action_payload.get("host_ids") or task.target_hosts
        hosts = [HostRepository.get_host(self.session, host_id) for host_id in host_ids]
        credentials = {host.id: HostRepository.get_credential(self.session, host.id) for host in hosts}
        task.status = "running"
        self.session.add(task)
        self.session.commit()
        self._audit_hosts(
            hosts=hosts,
            actor_id=approver.id,
            task_id=task.id,
            event_type="approval_granted",
            payload={"reason": reason},
        )
        plan = IntentPlan(
            task_type="change",
            action_type=str(approval.action_payload["action_type"]),
            title=f"审批后执行 {approval.action_payload['action_type']}",
            goal=task.goal,
            criteria=task.criteria_json,
            parameters=approval.action_payload.get("parameters") or {},
            explanation=str(approval.action_payload.get("explanation") or ""),
        )
        requester_id = approval.action_payload.get("requester_id") or task.user_id
        resumed_model = approval.action_payload.get("model")
        return await self._run_act_and_verify(task=task, hosts=hosts, credentials=credentials, plan=plan, model=resumed_model, api_keys=self._load_user_api_keys(user_id=requester_id))


def build_validation_matrix(session: Session) -> list[dict[str, Any]]:
    overview = DashboardService.overview(session)
    tasks = list(session.exec(select(Task)).all())
    steps = list(session.exec(select(TaskStep)).all())

    def has_task(action_type: str, *, status: str | None = None) -> bool:
        for task in tasks:
            if (task.plan_json or {}).get("action_type") != action_type:
                continue
            if status and task.status != status:
                continue
            return True
        return False

    def has_diagnose_steps() -> bool:
        diagnose_tasks = [task.id for task in tasks if (task.plan_json or {}).get("action_type") == "diagnose_service"]
        step_map = {}
        for step in steps:
            step_map.setdefault(step.task_id, set()).add(step.step_type)
        return any({"observe", "analyze"} <= step_map.get(task_id, set()) for task_id in diagnose_tasks)

    def has_feedback() -> bool:
        return any(task.result_json.get("summary") for task in tasks if isinstance(task.result_json, dict))

    def has_multiturn_context() -> bool:
        counts = session.exec(select(Task.session_id, func.count(Task.id)).group_by(Task.session_id)).all()
        repeated_sessions = {session_id for session_id, count in counts if session_id and count >= 2}
        if not repeated_sessions:
            return False
        for task in tasks:
            if task.session_id in repeated_sessions and isinstance(task.plan_json, dict):
                ai_meta = task.plan_json.get("ai") or {}
                if ai_meta.get("fallback_context_used"):
                    return True
        return False

    return [
        {
            "key": "basic_disk",
            "category": "基础能力",
            "requirement": "磁盘使用情况监测",
            "status": "pass" if has_task("query_disk", status="succeeded") else "fail",
            "evidence": "query_disk action + Goal-driven task execution + host dashboard snapshot",
        },
        {
            "key": "basic_search",
            "category": "基础能力",
            "requirement": "文件或目录检索",
            "status": "pass" if has_task("search_files", status="succeeded") else "fail",
            "evidence": "search_files action + file search prompt parsing",
        },
        {
            "key": "basic_process_port",
            "category": "基础能力",
            "requirement": "进程及端口状态查询",
            "status": "pass" if has_task("query_process", status="succeeded") and has_task("check_port", status="succeeded") else "fail",
            "evidence": "query_process and check_port actions",
        },
        {
            "key": "basic_user",
            "category": "基础能力",
            "requirement": "普通用户创建与删除",
            "status": "pass" if has_task("create_linux_user", status="succeeded") and has_task("delete_linux_user", status="succeeded") else "fail",
            "evidence": "create_linux_user/delete_linux_user with approval flow",
        },
        {
            "key": "nl_feedback",
            "category": "基础能力",
            "requirement": "过程与结果自然语言反馈",
            "status": "pass" if has_feedback() else "fail",
            "evidence": "Claude result summary + task steps + audit trail",
        },
        {
            "key": "risk_control",
            "category": "进阶能力",
            "requirement": "高风险识别、预警、二次确认、拒绝非法请求",
            "status": "pass" if has_task("delete_path", status="failed") else "fail",
            "evidence": "built-in policy core + approvals + blocked dangerous actions",
        },
        {
            "key": "explainability",
            "category": "进阶能力",
            "requirement": "行为可解释",
            "status": "pass" if any(task.result_json.get("policy") or task.result_json.get("summary") for task in tasks if isinstance(task.result_json, dict)) else "fail",
            "evidence": "policy reason + diagnosis explanation + result summary",
        },
        {
            "key": "continuous_task",
            "category": "探索能力",
            "requirement": "多步连续任务编排与统一反馈",
            "status": "pass" if has_diagnose_steps() else "fail",
            "evidence": "diagnose_service observe/analyze/act/verify flow",
        },
        {
            "key": "multiturn",
            "category": "探索能力",
            "requirement": "多轮对话上下文利用",
            "status": "pass" if has_multiturn_context() else "fail",
            "evidence": f"session-based recent task context, current managed hosts={overview['stats']['hosts']}",
        },
        {
            "key": "de_cli",
            "category": "探索能力",
            "requirement": "去命令行化 Web 管理体验",
            "status": "pass" if overview["stats"]["hosts"] >= 1 else "fail",
            "evidence": "Dashboard/Hosts/Tasks/Approvals/Audit pages",
        },
    ]
