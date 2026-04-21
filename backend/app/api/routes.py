from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..core.database import get_session
from ..models.entities import AgentNode, Approval, AuditLog, Host, Service, Task, TaskStep, User
from ..schemas.api import (
    AgentHeartbeatRequest,
    AgentRegistrationRequest,
    AuthStatusResponse,
    ApprovalDecisionRequest,
    BootstrapAdminRequest,
    HostCreate,
    LoginRequest,
    LoginResponse,
    PasswordChangeRequest,
    PasswordResetRequest,
    TaskExecuteRequest,
    UserCreateRequest,
    UserUpdateRequest,
)
from ..services.platform import (
    DashboardService,
    HostInspector,
    HostRepository,
    ServiceSync,
    now,
    serialize_model,
    upsert_audit,
)
from ..services.integrations import CapabilityCatalog
from ..services.monitoring import MonitoringCoreService
from ..services.orchestrator import GoalDrivenOrchestrator, build_validation_matrix
from ..services.security import (
    authenticate_user,
    create_access_token,
    get_current_user,
    hash_password,
    require_roles,
)


router = APIRouter()


def serialize_host(host: Host) -> dict:
    return serialize_model(host)


def serialize_user(user: User) -> dict:
    payload = serialize_model(user)
    payload.pop("password_hash", None)
    return payload


def count_active_admins(session: Session) -> int:
    return len(
        session.exec(select(User).where(User.role == "admin").where(User.is_active == True)).all()
    )


def ensure_last_admin_not_removed(session: Session, user: User, *, next_role: str | None = None, next_active: bool | None = None) -> None:
    role_after = next_role if next_role is not None else user.role
    active_after = next_active if next_active is not None else user.is_active
    if user.role == "admin" and user.is_active and (role_after != "admin" or not active_after):
        if count_active_admins(session) <= 1:
            raise HTTPException(status_code=400, detail="至少保留一个启用状态的管理员账号")


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/auth/status", response_model=AuthStatusResponse)
def auth_status(session: Annotated[Session, Depends(get_session)]) -> AuthStatusResponse:
    user_count = len(session.exec(select(User)).all())
    return AuthStatusResponse(initialized=user_count > 0, user_count=user_count)


@router.post("/auth/bootstrap", response_model=LoginResponse)
def bootstrap_admin(payload: BootstrapAdminRequest, session: Annotated[Session, Depends(get_session)]) -> LoginResponse:
    user_count = len(session.exec(select(User)).all())
    if user_count > 0:
        raise HTTPException(status_code=409, detail="系统已初始化，不能重复创建管理员")
    username = payload.username.strip()
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="管理员账号至少 3 个字符")
    if len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="管理员密码至少 8 个字符")
    user = User(username=username, password_hash=hash_password(payload.password), role="admin", is_active=True)
    session.add(user)
    session.commit()
    session.refresh(user)
    token = create_access_token(user.username)
    return LoginResponse(access_token=token, user=serialize_user(user))


@router.post("/auth/login", response_model=LoginResponse)
def login(payload: LoginRequest, session: Annotated[Session, Depends(get_session)]) -> LoginResponse:
    user = authenticate_user(session, payload.username, payload.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid credentials")
    token = create_access_token(user.username)
    return LoginResponse(access_token=token, user=serialize_user(user))


@router.get("/auth/me")
def me(current_user: Annotated[User, Depends(get_current_user)]) -> dict:
    return serialize_user(current_user)


@router.post("/auth/change-password")
def change_password(
    payload: PasswordChangeRequest,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    if len(payload.new_password) < 8:
        raise HTTPException(status_code=400, detail="新密码至少 8 个字符")
    authenticated = authenticate_user(session, current_user.username, payload.current_password)
    if not authenticated:
        raise HTTPException(status_code=400, detail="当前密码不正确")
    current_user.password_hash = hash_password(payload.new_password)
    session.add(current_user)
    session.commit()
    upsert_audit(session, actor_id=current_user.id, event_type="user_password_changed", payload={"user_id": current_user.id})
    return {"ok": True}


@router.get("/users")
def list_users(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(require_roles("admin"))],
) -> list[dict]:
    users = session.exec(select(User).order_by(User.id.asc())).all()
    return [serialize_user(user) for user in users]


@router.post("/users")
def create_user(
    payload: UserCreateRequest,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(require_roles("admin"))],
) -> dict:
    username = payload.username.strip()
    if len(username) < 3:
        raise HTTPException(status_code=400, detail="账号名至少 3 个字符")
    if len(payload.password) < 8:
        raise HTTPException(status_code=400, detail="密码至少 8 个字符")
    existing = session.exec(select(User).where(User.username == username)).first()
    if existing:
        raise HTTPException(status_code=409, detail="账号已存在")
    user = User(
        username=username,
        password_hash=hash_password(payload.password),
        role=payload.role,
        is_active=payload.is_active,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    upsert_audit(session, actor_id=current_user.id, event_type="user_created", payload={"user": serialize_user(user)})
    return serialize_user(user)


@router.patch("/users/{user_id}")
def update_user(
    user_id: int,
    payload: UserUpdateRequest,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(require_roles("admin"))],
) -> dict:
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    ensure_last_admin_not_removed(session, user, next_role=payload.role, next_active=payload.is_active)
    if payload.role is not None:
        user.role = payload.role
    if payload.is_active is not None:
        user.is_active = payload.is_active
    session.add(user)
    session.commit()
    session.refresh(user)
    upsert_audit(session, actor_id=current_user.id, event_type="user_updated", payload={"user": serialize_user(user)})
    return serialize_user(user)


@router.post("/users/{user_id}/reset-password")
def reset_user_password(
    user_id: int,
    payload: PasswordResetRequest,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(require_roles("admin"))],
) -> dict:
    if len(payload.new_password) < 8:
        raise HTTPException(status_code=400, detail="新密码至少 8 个字符")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.password_hash = hash_password(payload.new_password)
    session.add(user)
    session.commit()
    upsert_audit(
        session,
        actor_id=current_user.id,
        event_type="user_password_reset",
        payload={"user_id": user.id, "username": user.username},
    )
    return {"ok": True}


@router.delete("/users/{user_id}")
def delete_user(
    user_id: int,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(require_roles("admin"))],
) -> dict:
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == current_user.id:
        raise HTTPException(status_code=400, detail="不能删除当前登录账号")
    ensure_last_admin_not_removed(session, user, next_active=False, next_role="operator")
    session.delete(user)
    session.commit()
    upsert_audit(
        session,
        actor_id=current_user.id,
        event_type="user_deleted",
        payload={"user_id": user_id, "username": user.username},
    )
    return {"ok": True}


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
    return [serialize_host(host) for host in hosts]


@router.post("/hosts")
def create_host(
    payload: HostCreate,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(require_roles("admin", "operator"))],
) -> dict:
    host = HostRepository.create_host(session, payload.model_dump())
    host_payload = serialize_host(host)
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
        **serialize_host(host),
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
    MonitoringCoreService.record_sample(session, host=host, metrics=metrics, source="manual-refresh")
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
    steps = session.exec(select(TaskStep).where(TaskStep.task_id == task_id).order_by(TaskStep.id.asc())).all()
    return {
        **serialize_model(task),
        "steps": [serialize_model(step) for step in steps],
    }


@router.post("/tasks/execute")
async def execute_task(
    payload: TaskExecuteRequest,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    orchestrator = GoalDrivenOrchestrator(session, current_user)
    task = await orchestrator.execute(payload.prompt, payload.session_id, payload.selected_host_ids, False)
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


@router.get("/validation/pdf")
def get_pdf_validation(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    return {"items": build_validation_matrix(session)}


@router.get("/integrations")
async def list_integrations(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    return CapabilityCatalog.summary(session)


@router.post("/monitoring/collect")
async def collect_monitoring_snapshots(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(require_roles("admin", "operator"))],
) -> dict:
    hosts = HostRepository.list_hosts(session)
    collected: list[dict] = []
    for host in hosts:
        credential = HostRepository.get_credential(session, host.id)
        try:
            metrics = await HostInspector.metrics(host, credential)
            host.metrics_json = metrics
            host.last_seen_at = now()
            session.add(host)
            session.commit()
            sample = MonitoringCoreService.record_sample(session, host=host, metrics=metrics, source="full-collection")
            collected.append({"host_id": host.id, "host_name": host.name, "sampled_at": sample.sampled_at.isoformat()})
        except Exception as exc:
            collected.append({"host_id": host.id, "host_name": host.name, "error": str(exc)})
    return {"collected": collected}


@router.get("/monitoring/hosts/{host_id}/summary")
def host_monitoring_summary(
    host_id: int,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    host = HostRepository.get_host(session, host_id)
    return MonitoringCoreService.host_summary(session, host)


@router.get("/monitoring/hosts/{host_id}/timeseries")
def host_monitoring_timeseries(
    host_id: int,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
    hours: int = 6,
) -> dict:
    host = HostRepository.get_host(session, host_id)
    return MonitoringCoreService.host_timeseries(session, host, hours=hours)


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
            MonitoringCoreService.record_sample(session, host=host, metrics=payload.metrics, source="agent-heartbeat")
        session.add(host)
        if payload.services:
            ServiceSync.sync(session, host, payload.services)
    session.commit()
    return {"status": "ok"}
