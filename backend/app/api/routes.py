from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..core.database import get_session
from ..models.entities import AgentNode, Approval, AuditLog, Host, Service, Task, User
from ..schemas.api import (
    AgentHeartbeatRequest,
    AgentRegistrationRequest,
    ApprovalDecisionRequest,
    HostCreate,
    LoginRequest,
    LoginResponse,
    TaskExecuteRequest,
)
from ..services.platform import (
    DashboardService,
    GoalDrivenOrchestrator,
    HostInspector,
    HostRepository,
    ServiceSync,
    now,
    serialize_model,
    upsert_audit,
)
from ..services.security import (
    authenticate_user,
    create_access_token,
    get_current_user,
    hash_password,
    require_roles,
)


router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/auth/login", response_model=LoginResponse)
def login(payload: LoginRequest, session: Annotated[Session, Depends(get_session)]) -> LoginResponse:
    user = authenticate_user(session, payload.username, payload.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token(user.username)
    user_payload = serialize_model(user)
    user_payload.pop("password_hash", None)
    return LoginResponse(access_token=token, user=user_payload)


@router.get("/auth/me")
def me(current_user: Annotated[User, Depends(get_current_user)]) -> dict:
    payload = serialize_model(current_user)
    payload.pop("password_hash", None)
    return payload


@router.get("/dashboard/overview")
def dashboard_overview(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    return DashboardService.overview(session)


@router.get("/hosts")
def list_hosts(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict]:
    hosts = HostRepository.list_hosts(session)
    return [serialize_model(host) for host in hosts]


@router.post("/hosts")
def create_host(
    payload: HostCreate,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(require_roles("admin", "operator"))],
) -> dict:
    host = HostRepository.create_host(session, payload.model_dump())
    host_payload = serialize_model(host)
    upsert_audit(session, actor_id=current_user.id, host_id=host.id, event_type="host_created", payload=host_payload)
    return host_payload


@router.get("/hosts/{host_id}")
def get_host(
    host_id: int,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    host = HostRepository.get_host(session, host_id)
    services = session.exec(select(Service).where(Service.host_id == host_id)).all()
    return {
        **serialize_model(host),
        "services": [serialize_model(service) for service in services],
    }


@router.post("/hosts/{host_id}/profile")
async def profile_host(
    host_id: int,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    host = HostRepository.get_host(session, host_id)
    credential = HostRepository.get_credential(session, host_id)
    profile = await HostInspector.profile(host, credential)
    host.profile_json = profile
    host.os_type = profile.get("os_name", host.os_type)
    host.os_version = profile.get("os_version", host.os_version)
    host.kernel_version = profile.get("kernel", host.kernel_version)
    host.package_manager = profile.get("package_manager", host.package_manager)
    host.last_profiled_at = now()
    host.status = "online"
    host.last_seen_at = now()
    session.add(host)
    session.commit()
    return {"host": serialize_model(host), "profile": profile}


@router.post("/hosts/{host_id}/metrics")
async def metrics_host(
    host_id: int,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    host = HostRepository.get_host(session, host_id)
    credential = HostRepository.get_credential(session, host_id)
    metrics = await HostInspector.metrics(host, credential)
    host.metrics_json = metrics
    host.last_seen_at = now()
    session.add(host)
    session.commit()
    return {"metrics": metrics}


@router.post("/hosts/{host_id}/discover")
async def discover_host_services(
    host_id: int,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    host = HostRepository.get_host(session, host_id)
    credential = HostRepository.get_credential(session, host_id)
    services = await HostInspector.discover_services(host, credential)
    stored = ServiceSync.sync(session, host, services)
    return {"services": [serialize_model(service) for service in stored]}


@router.get("/services")
def list_services(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict]:
    services = session.exec(select(Service).order_by(Service.id.desc())).all()
    return [serialize_model(service) for service in services]


@router.get("/tasks")
def list_tasks(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict]:
    tasks = session.exec(select(Task).order_by(Task.id.desc())).all()
    return [serialize_model(task) for task in tasks]


@router.get("/tasks/{task_id}")
def get_task(
    task_id: int,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    task = session.get(Task, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return serialize_model(task)


@router.post("/tasks/execute")
async def execute_task(
    payload: TaskExecuteRequest,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    orchestrator = GoalDrivenOrchestrator(session, current_user)
    task = await orchestrator.execute(payload.prompt, payload.session_id, payload.selected_host_ids, payload.auto_approve)
    return serialize_model(task)


@router.get("/approvals")
def list_approvals(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict]:
    approvals = session.exec(select(Approval).order_by(Approval.id.desc())).all()
    return [serialize_model(approval) for approval in approvals]


@router.post("/approvals/{approval_id}")
async def decide_approval(
    approval_id: int,
    payload: ApprovalDecisionRequest,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(require_roles("admin", "approver"))],
) -> dict:
    approval = session.get(Approval, approval_id)
    if not approval:
        raise HTTPException(status_code=404, detail="Approval not found")
    orchestrator = GoalDrivenOrchestrator(session, current_user)
    task = await orchestrator.resume_after_approval(approval, current_user, payload.approved, payload.reason)
    return {"approval": serialize_model(approval), "task": serialize_model(task)}


@router.get("/audit")
def list_audit_logs(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict]:
    logs = session.exec(select(AuditLog).order_by(AuditLog.id.desc()).limit(200)).all()
    return [serialize_model(log) for log in logs]


@router.post("/agents/register")
def register_agent(
    payload: AgentRegistrationRequest,
    session: Annotated[Session, Depends(get_session)],
) -> dict:
    agent = session.exec(select(AgentNode).where(AgentNode.registration_token == payload.registration_token)).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Invalid registration token")
    agent.identity = payload.identity
    agent.version = payload.version
    agent.capabilities = payload.capabilities
    agent.status = "registered"
    agent.last_heartbeat_at = now()
    session.add(agent)
    session.commit()
    return {"status": "registered", "identity": agent.identity}


@router.post("/agents/heartbeat")
def agent_heartbeat(
    payload: AgentHeartbeatRequest,
    session: Annotated[Session, Depends(get_session)],
) -> dict:
    agent = session.exec(select(AgentNode).where(AgentNode.identity == payload.identity)).first()
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    agent.last_heartbeat_at = now()
    agent.status = "online"
    session.add(agent)
    if agent.host_id:
        host = HostRepository.get_host(session, agent.host_id)
        host.status = "registered"
        host.last_seen_at = now()
        if payload.profile:
            host.profile_json = payload.profile
            host.os_type = payload.profile.get("os_name", host.os_type)
            host.os_version = payload.profile.get("os_version", host.os_version)
            host.kernel_version = payload.profile.get("kernel", host.kernel_version)
            host.package_manager = payload.profile.get("package_manager", host.package_manager)
        if payload.metrics:
            host.metrics_json = payload.metrics
        session.add(host)
        if payload.services:
            ServiceSync.sync(session, host, payload.services)
    session.commit()
    return {"status": "ok"}
