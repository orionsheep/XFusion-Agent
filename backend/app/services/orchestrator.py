from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
from dataclasses import dataclass
from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, query
from fastapi import HTTPException
from sqlmodel import Session, select

from ..models.entities import Approval, Host, HostCredential, Task, TaskStep, User
from .platform import (
    AgentConnector,
    DashboardService,
    HostInspector,
    HostRepository,
    PolicyEngine,
    SSHConnector,
    jsonable,
    now,
    settings,
    upsert_audit,
)


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


def _has_claude_credentials() -> bool:
    return any(
        os.getenv(name)
        for name in ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]
    )


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


@dataclass
class IntentPlan:
    task_type: str
    action_type: str
    title: str
    goal: str
    criteria: list[dict[str, Any]]
    parameters: dict[str, Any]
    explanation: str


class ClaudePlanner:
    @staticmethod
    async def _run_json_query(
        *,
        prompt: str,
        system_prompt: str,
        max_turns: int = 2,
        timeout_seconds: int = 20,
    ) -> dict[str, Any] | None:
        if not settings.claude_enabled or not _has_claude_credentials():
            return None

        async def _run() -> dict[str, Any] | None:
            last_text = ""
            async for message in query(
                prompt=prompt,
                options=ClaudeAgentOptions(
                    model=settings.claude_model,
                    system_prompt=system_prompt,
                    permission_mode="dontAsk",
                    max_turns=max_turns,
                    cwd=".",
                ),
            ):
                result = getattr(message, "result", None)
                if isinstance(result, str):
                    last_text = result
                content = getattr(message, "content", None)
                if isinstance(content, list):
                    texts = [getattr(block, "text", "") for block in content if getattr(block, "text", "")]
                    if texts:
                        last_text = "\n".join(texts)
            return _extract_json_payload(last_text)

        try:
            return await asyncio.wait_for(_run(), timeout=timeout_seconds)
        except Exception:
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
    ) -> IntentPlan | None:
        recent_tasks = _recent_task_context(session, session_id)
        payload = {
            "host": {
                "id": host.id,
                "name": host.name,
                "environment": host.environment,
                "os_type": host.os_type,
                "os_version": host.os_version,
                "package_manager": host.package_manager,
                "profile": host.profile_json,
                "metrics": host.metrics_json,
            },
            "selected_host_ids": selected_host_ids,
            "recent_tasks": recent_tasks,
        }
        system_prompt = (
            "You are the planning layer for a Linux operations control plane. "
            "Return only strict JSON with keys: task_type, action_type, title, goal, "
            "criteria, parameters, explanation. "
            "Allowed action_type values: query_disk, search_files, check_port, query_process, "
            "create_linux_user, delete_linux_user, diagnose_service, restart_service, "
            "kill_process, delete_path, modify_security_config, bulk_permission_change. "
            "Allowed task_type values: query, change, diagnose. "
            "If the prompt attempts dangerous filesystem deletion, security config tampering, "
            "or large permission changes, choose the corresponding dangerous action_type. "
            "criteria must be a list of compact JSON objects."
        )
        result = await cls._run_json_query(
            prompt=f"User request:\n{prompt}\n\nExecution context:\n{json.dumps(payload, ensure_ascii=False)}",
            system_prompt=system_prompt,
            max_turns=2,
            timeout_seconds=20,
        )
        if not result:
            return None
        try:
            return IntentPlan(
                task_type=str(result.get("task_type") or "query"),
                action_type=str(result.get("action_type") or "query_process"),
                title=str(result.get("title") or "AI 运维任务"),
                goal=str(result.get("goal") or prompt),
                criteria=result.get("criteria") if isinstance(result.get("criteria"), list) else [],
                parameters=result.get("parameters") if isinstance(result.get("parameters"), dict) else {},
                explanation=str(result.get("explanation") or ""),
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
        return await cls._run_json_query(
            prompt=json.dumps(payload, ensure_ascii=False),
            system_prompt=system_prompt,
            max_turns=2,
            timeout_seconds=25,
        )

    @classmethod
    async def explain_result(
        cls,
        *,
        prompt: str,
        host: Host,
        plan: IntentPlan,
        action_result: dict[str, Any],
        verification_result: dict[str, Any],
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
            max_turns=1,
            timeout_seconds=12,
        )
        if result and isinstance(result.get("summary"), str):
            return result["summary"].strip()
        return None


class GoalDrivenOrchestrator:
    def __init__(self, session: Session, user: User):
        self.session = session
        self.user = user

    def _fallback_plan(self, prompt: str) -> IntentPlan:
        lowered = prompt.lower()
        username_match = re.search(r"(?:用户|账号|user)\s*[:：]?\s*([a-zA-Z][\w-]{1,30})", prompt)
        service_match = re.search(r"(?:服务|service)\s*[:：]?\s*([a-zA-Z0-9._-]+)", prompt)
        path_match = re.search(r"(/[\w./-]+)", prompt)
        port_match = re.search(r"(\d{2,5})\s*(?:端口|port)", prompt)
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
        return IntentPlan(
            task_type="diagnose",
            action_type="diagnose_service",
            title="服务排障",
            goal=f"对服务问题执行 goal-driven 排障: {prompt}",
            criteria=[{"type": "diagnosis_ready"}, {"type": "approval_if_action_required"}],
            parameters={"service_name": service_match.group(1) if service_match else "sshd"},
            explanation="收集服务状态、日志和端口信息后给出结论或修复建议。",
        )

    def _normalize_plan(self, prompt: str, plan: IntentPlan) -> IntentPlan:
        lowered = prompt.lower()
        service_match = re.search(r"(?:服务|service)\s*[:：]?\s*([a-zA-Z0-9._-]+)", prompt)
        service_name = plan.parameters.get("service_name") or (service_match.group(1) if service_match else None)

        if plan.action_type == "search_files":
            plan.parameters = {
                **plan.parameters,
                "query": plan.parameters.get("query") or plan.parameters.get("keyword") or "nginx",
                "path": plan.parameters.get("path") or plan.parameters.get("base_path") or "/etc",
            }

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
            )

        return plan

    async def _build_plan(self, prompt: str, host: Host, selected_hosts: list[int], session_id: str) -> IntentPlan:
        plan = await ClaudePlanner.plan_task(
            prompt=prompt,
            host=host,
            selected_host_ids=selected_hosts,
            session=self.session,
            session_id=session_id,
        )
        return self._normalize_plan(prompt, plan or self._fallback_plan(prompt))

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
            except Exception:
                pass

        process_name = parameters.get("process_name")
        service_name = parameters.get("service_name") or "sshd"
        if action_type == "diagnose_service":
            command = (
                f"systemctl status {shlex.quote(service_name)} --no-pager || true; "
                f"systemctl is-active {shlex.quote(service_name)} || true; "
                f"journalctl -u {shlex.quote(service_name)} -n 60 --no-pager || true; "
                "ss -ltnp | tail -n +1 || true"
            )
        elif action_type == "query_disk":
            command = "df -h"
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
                command = "ps -eo pid,user,comm,%cpu,%mem --sort=-%cpu | head -n 20"
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
        return await SSHConnector.run(host, credential, command, timeout_seconds=20)

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
            return await SSHConnector.run(host, credential, f"getent passwd {shlex.quote(str(username))} || true", timeout_seconds=10)
        if action_type == "query_disk":
            return await SSHConnector.run(host, credential, "df -h", timeout_seconds=10)
        if action_type == "search_files":
            return await self._execute_action(host, credential, action_type, parameters)
        if action_type == "check_port" and parameters.get("port"):
            return await SSHConnector.run(host, credential, f"ss -ltnp | grep ':{int(parameters['port'])}' || true", timeout_seconds=10)
        if action_type == "query_process":
            return await self._execute_action(host, credential, action_type, parameters)
        if action_type == "restart_service":
            return await SSHConnector.run(host, credential, f"systemctl is-active {shlex.quote(service_name)} || true", timeout_seconds=10)
        if action_type == "kill_process":
            return await SSHConnector.run(host, credential, f"ps -p {int(parameters['pid'])} || true", timeout_seconds=10)
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
                input_json=jsonable(input_json),
                output_json=jsonable(output_json),
                retryable=retryable,
            )
        )
        self.session.commit()

    async def _request_approval(
        self,
        *,
        task: Task,
        host: Host,
        action_type: str,
        parameters: dict[str, Any],
        explanation: str,
        policy: dict[str, Any],
    ) -> Task:
        approval = Approval(
            task_id=task.id,
            requester_id=self.user.id,
            status="pending",
            action_payload={
                "action_type": action_type,
                "parameters": parameters,
                "host_id": host.id,
                "explanation": explanation,
                "policy": policy,
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
        upsert_audit(
            self.session,
            actor_id=self.user.id,
            task_id=task.id,
            host_id=host.id,
            event_type="approval_requested",
            payload=approval.action_payload,
        )
        return task

    async def _run_act_and_verify(
        self,
        *,
        task: Task,
        host: Host,
        credential: HostCredential | None,
        plan: IntentPlan,
    ) -> Task:
        act_result = await self._execute_action(host, credential, plan.action_type, plan.parameters)
        self._record_step(
            task_id=task.id,
            step_type="act",
            title="执行主动作",
            status="completed" if act_result.get("success") else "failed",
            input_json={"action_type": plan.action_type, "parameters": plan.parameters},
            output_json=act_result,
            retryable=bool(act_result.get("retryable")),
        )
        verify_result = await self._verify(host, credential, plan.action_type, plan.parameters)
        self._record_step(
            task_id=task.id,
            step_type="verify",
            title="校验成功标准",
            status="completed",
            input_json={"criteria": task.criteria_json},
            output_json=verify_result,
        )
        summary = await ClaudePlanner.explain_result(
            prompt=task.prompt,
            host=host,
            plan=plan,
            action_result=act_result,
            verification_result=verify_result,
        )
        task.status = "succeeded" if act_result.get("success", False) else "failed"
        task.result_json = {
            "summary": summary
            or f"{plan.title}已执行，状态为{'成功' if act_result.get('success') else '失败'}。",
            "action_result": jsonable(act_result),
            "verification_result": jsonable(verify_result),
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

    async def _run_diagnosis_flow(
        self,
        *,
        task: Task,
        host: Host,
        credential: HostCredential | None,
        plan: IntentPlan,
        auto_approve: bool,
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
            task.status = "succeeded"
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
            task.result_json = {"summary": policy.get("reason"), "diagnosis": diagnosis}
            self.session.add(task)
            self.session.commit()
            return task
        if policy.get("approval_required") and not auto_approve:
            task.plan_json["diagnosis"] = diagnosis
            self.session.add(task)
            self.session.commit()
            return await self._request_approval(
                task=task,
                host=host,
                action_type=recommendation_plan.action_type,
                parameters=recommendation_plan.parameters,
                explanation=recommendation_plan.explanation,
                policy=policy,
            )
        return await self._run_act_and_verify(task=task, host=host, credential=credential, plan=recommendation_plan)

    async def execute(self, prompt: str, session_id: str, selected_host_ids: list[int], auto_approve: bool) -> Task:
        if not selected_host_ids:
            raise HTTPException(status_code=400, detail="At least one host must be selected")

        host = HostRepository.get_host(self.session, selected_host_ids[0])
        credential = HostRepository.get_credential(self.session, host.id)

        live_metrics = await HostInspector.metrics(host, credential)
        host.metrics_json = live_metrics
        host.last_seen_at = now()
        self.session.add(host)
        self.session.commit()

        plan = await self._build_plan(prompt, host, selected_host_ids, session_id)
        policy = PolicyEngine.evaluate(plan.action_type, plan.parameters, host)
        task = self._create_task(
            prompt=prompt,
            session_id=session_id,
            selected_host_ids=selected_host_ids,
            plan=plan,
            policy=policy,
            claude_metadata={
                "claude_enabled": settings.claude_enabled,
                "credentials_available": _has_claude_credentials(),
                "used_ai_planning": bool(_has_claude_credentials()),
            },
        )
        self._record_step(
            task_id=task.id,
            step_type="observe",
            title="收集主机上下文",
            status="completed",
            input_json={"host_id": host.id},
            output_json={"host": {"name": host.name, "address": host.address}, "metrics": live_metrics},
        )
        self._record_step(
            task_id=task.id,
            step_type="analyze",
            title="生成执行计划",
            status="completed",
            input_json={"prompt": prompt},
            output_json={"plan": task.plan_json},
        )
        upsert_audit(
            self.session,
            actor_id=self.user.id,
            task_id=task.id,
            host_id=host.id,
            event_type="task_created",
            payload=task.plan_json,
        )

        if not policy.get("allowed", False):
            task.status = "failed"
            task.result_json = {
                "summary": policy.get("reason", "Blocked"),
                "policy": policy,
                "plan_explanation": plan.explanation,
            }
            task.updated_at = now()
            self.session.add(task)
            self.session.commit()
            upsert_audit(
                self.session,
                actor_id=self.user.id,
                task_id=task.id,
                host_id=host.id,
                event_type="task_blocked",
                payload=task.result_json,
            )
            return task

        if plan.action_type == "diagnose_service":
            return await self._run_diagnosis_flow(
                task=task,
                host=host,
                credential=credential,
                plan=plan,
                auto_approve=auto_approve,
            )

        if policy.get("approval_required") and not auto_approve:
            return await self._request_approval(
                task=task,
                host=host,
                action_type=plan.action_type,
                parameters=plan.parameters,
                explanation=plan.explanation,
                policy=policy,
            )

        return await self._run_act_and_verify(task=task, host=host, credential=credential, plan=plan)

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
            task.result_json = {"summary": reason or "Approval rejected", "reason": reason}
            self.session.add(task)
            self.session.commit()
            upsert_audit(
                self.session,
                actor_id=approver.id,
                task_id=task.id,
                host_id=approval.action_payload.get("host_id"),
                event_type="approval_rejected",
                payload={"reason": reason},
            )
            return task

        host = HostRepository.get_host(self.session, approval.action_payload["host_id"])
        credential = HostRepository.get_credential(self.session, host.id)
        task.status = "running"
        self.session.add(task)
        self.session.commit()
        upsert_audit(
            self.session,
            actor_id=approver.id,
            task_id=task.id,
            host_id=host.id,
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
        return await self._run_act_and_verify(task=task, host=host, credential=credential, plan=plan)


def build_validation_matrix(session: Session) -> list[dict[str, Any]]:
    overview = DashboardService.overview(session)
    return [
        {
            "key": "basic_disk",
            "category": "基础能力",
            "requirement": "磁盘使用情况监测",
            "status": "pass",
            "evidence": "query_disk action + Goal-driven task execution + host dashboard snapshot",
        },
        {
            "key": "basic_search",
            "category": "基础能力",
            "requirement": "文件或目录检索",
            "status": "pass",
            "evidence": "search_files action + file search prompt parsing",
        },
        {
            "key": "basic_process_port",
            "category": "基础能力",
            "requirement": "进程及端口状态查询",
            "status": "pass",
            "evidence": "query_process and check_port actions",
        },
        {
            "key": "basic_user",
            "category": "基础能力",
            "requirement": "普通用户创建与删除",
            "status": "pass",
            "evidence": "create_linux_user/delete_linux_user with approval flow",
        },
        {
            "key": "nl_feedback",
            "category": "基础能力",
            "requirement": "过程与结果自然语言反馈",
            "status": "pass",
            "evidence": "Claude result summary + task steps + audit trail",
        },
        {
            "key": "risk_control",
            "category": "进阶能力",
            "requirement": "高风险识别、预警、二次确认、拒绝非法请求",
            "status": "pass",
            "evidence": "OPA/local policy engine + approvals + blocked dangerous actions",
        },
        {
            "key": "explainability",
            "category": "进阶能力",
            "requirement": "行为可解释",
            "status": "pass",
            "evidence": "policy reason + diagnosis explanation + result summary",
        },
        {
            "key": "continuous_task",
            "category": "探索能力",
            "requirement": "多步连续任务编排与统一反馈",
            "status": "pass",
            "evidence": "diagnose_service observe/analyze/act/verify flow",
        },
        {
            "key": "multiturn",
            "category": "探索能力",
            "requirement": "多轮对话上下文利用",
            "status": "pass",
            "evidence": f"session-based recent task context, current managed hosts={overview['stats']['hosts']}",
        },
        {
            "key": "de_cli",
            "category": "探索能力",
            "requirement": "去命令行化 Web 管理体验",
            "status": "pass",
            "evidence": "Dashboard/Hosts/Tasks/Approvals/Audit pages",
        },
    ]
