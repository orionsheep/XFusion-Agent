from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import JSON, Column
from sqlmodel import Field, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    username: str = Field(index=True, unique=True)
    password_hash: str
    role: str = "admin"
    is_active: bool = True
    created_at: datetime = Field(default_factory=utcnow)


class Host(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True)
    address: str
    ssh_port: int = 22
    username: str = "root"
    connection_mode: str = "hybrid"
    auth_type: str = "key"
    environment: str = "production"
    labels: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    risk_level: str = "medium"
    status: str = "unknown"
    os_type: str | None = None
    os_version: str | None = None
    kernel_version: str | None = None
    package_manager: str | None = None
    profile_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    metrics_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    last_profiled_at: datetime | None = None
    last_seen_at: datetime | None = None
    host_key_fingerprint: str | None = None
    agent_url: str | None = None
    agent_identity: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class HostCredential(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    host_id: int = Field(index=True)
    encrypted_secret: str
    auth_type: str
    has_passphrase: bool = False
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class AgentNode(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    host_id: int | None = Field(default=None, index=True)
    identity: str = Field(index=True, unique=True)
    registration_token: str
    version: str | None = None
    last_heartbeat_at: datetime | None = None
    capabilities: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    status: str = "pending"
    created_at: datetime = Field(default_factory=utcnow)


class Service(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    host_id: int = Field(index=True)
    service_key: str = Field(index=True)
    name: str
    service_type: str
    runtime_type: str
    status: str
    ports: list[int] = Field(default_factory=list, sa_column=Column(JSON))
    process_ref: str | None = None
    config_path: str | None = None
    log_hint: str | None = None
    discovery_source: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    evidence_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    confidence: float = 1.0
    last_seen_at: datetime = Field(default_factory=utcnow)
    created_at: datetime = Field(default_factory=utcnow)


class Task(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    session_id: str = Field(index=True)
    user_id: int = Field(index=True)
    title: str
    prompt: str
    task_type: str
    goal: str
    criteria_json: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    target_hosts: list[int] = Field(default_factory=list, sa_column=Column(JSON))
    risk_level: str = "L0"
    status: str = "queued"
    execution_mode: str = "goal-driven"
    plan_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    result_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    approval_required: bool = False
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class TaskStep(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    task_id: int = Field(index=True)
    step_type: str
    status: str = "queued"
    title: str
    input_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    output_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    retryable: bool = False
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class Approval(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    task_id: int = Field(index=True)
    requester_id: int
    approver_id: int | None = None
    status: str = "pending"
    decision_reason: str | None = None
    action_payload: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)
    decided_at: datetime | None = None


class AuditLog(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    actor_id: int | None = None
    task_id: int | None = Field(default=None, index=True)
    host_id: int | None = Field(default=None, index=True)
    event_type: str
    payload_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON))
    created_at: datetime = Field(default_factory=utcnow)


class HostMetricSample(SQLModel, table=True):
    id: int | None = Field(default=None, primary_key=True)
    host_id: int = Field(index=True)
    cpu_percent: float | None = None
    memory_percent: float | None = None
    root_disk_percent: float | None = None
    load1: float | None = None
    top_processes: list[dict[str, Any]] = Field(default_factory=list, sa_column=Column(JSON))
    source: str = "control-plane"
    sampled_at: datetime = Field(default_factory=utcnow, index=True)
