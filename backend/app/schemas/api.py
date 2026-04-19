from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str
    password: str


class LoginResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict[str, Any]


class AuthStatusResponse(BaseModel):
    initialized: bool
    user_count: int


class BootstrapAdminRequest(BaseModel):
    username: str
    password: str


class UserCreateRequest(BaseModel):
    username: str
    password: str
    role: str = "operator"
    is_active: bool = True


class UserUpdateRequest(BaseModel):
    role: str | None = None
    is_active: bool | None = None


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str


class PasswordResetRequest(BaseModel):
    new_password: str


class HostCreate(BaseModel):
    name: str
    address: str
    ssh_port: int = 22
    username: str = "root"
    connection_mode: str = "hybrid"
    auth_type: str = "key"
    environment: str = "production"
    labels: list[str] = Field(default_factory=list)
    risk_level: str = "medium"
    ssh_private_key: str | None = None
    ssh_password: str | None = None
    agent_url: str | None = None


class TaskExecuteRequest(BaseModel):
    prompt: str
    session_id: str = "default"
    selected_host_ids: list[int] = Field(default_factory=list)
    auto_approve: bool = False


class ApprovalDecisionRequest(BaseModel):
    approved: bool
    reason: str | None = None


class AgentRegistrationRequest(BaseModel):
    registration_token: str
    identity: str
    version: str
    capabilities: dict[str, Any] = Field(default_factory=dict)


class AgentHeartbeatRequest(BaseModel):
    identity: str
    metrics: dict[str, Any] = Field(default_factory=dict)
    profile: dict[str, Any] = Field(default_factory=dict)
    services: list[dict[str, Any]] = Field(default_factory=list)


class AgentExecutionRequest(BaseModel):
    action_type: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    dry_run: bool = False
