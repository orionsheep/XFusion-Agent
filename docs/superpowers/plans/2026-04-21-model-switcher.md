# Model Switcher & Per-User API Key Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个用户可在 Settings 页面配置自己的 LLM Provider API Key，并在 AgentPanel 的输入区切换模型执行任务。

**Architecture:** 新增 `ProviderKey` 数据库表（按 user_id + provider_name 唯一），后端用 Fernet 加密存储，执行任务时从 DB 加载用户 Key 注入 LLM Router。前端 Settings 页新增配置卡，AgentPanel 输入区加小型 Select 下拉选模型。

**Tech Stack:** FastAPI, SQLModel, SQLite, React, Ant Design, Axios, @tanstack/react-query

---

## 文件变更总览

### 新建
- `docs/superpowers/plans/2026-04-21-model-switcher.md` — 本文件

### 修改（后端）
- `backend/app/models/entities.py` — 新增 `ProviderKey` SQLModel 实体
- `backend/app/schemas/api.py` — 新增 `ProviderKeyUpsertRequest`、`ProviderInfo`；`TaskExecuteRequest` 加 `model` 字段
- `backend/app/services/llm_router.py` — `chat_completion` / `run_agent_loop` 支持 `api_keys` override；`ProviderRegistry` 新增 `list_provider_info` 方法
- `backend/app/services/orchestrator.py` — `ClaudePlanner` 接收 `model` / `api_keys`；`GoalDrivenOrchestrator.execute()` 加载用户 Key

### 修改（后端路由）
- `backend/app/api/routes.py` — 新增 `GET /providers`、`PUT /providers/{name}/key`、`DELETE /providers/{name}/key`

### 修改（前端）
- `frontend/src/services/api.ts` — 新增 `fetchProviders`、`upsertProviderKey`、`deleteProviderKey`；`executeTask` payload 加 `model?`
- `frontend/src/pages/SettingsPage.tsx` — 新增"AI 模型配置"卡片
- `frontend/src/components/AgentPanel.tsx` — 新增模型 Select 下拉

---

## Task 1: 新增 `ProviderKey` 数据库实体

**Files:**
- Modify: `backend/app/models/entities.py`

- [ ] **Step 1: 在 `entities.py` 末尾添加 `ProviderKey` 模型**

打开 `backend/app/models/entities.py`，在文件末尾追加：

```python
class ProviderKey(SQLModel, table=True):
    __tablename__ = "provider_keys"
    __table_args__ = (UniqueConstraint("user_id", "provider_name"),)

    id: int | None = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True)
    provider_name: str = Field(max_length=64)
    encrypted_key: str
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
```

同时确认文件顶部已有这些 import（如缺少则添加）：

```python
from sqlmodel import Field, SQLModel, UniqueConstraint
from datetime import datetime, timezone
```

> `UniqueConstraint` 确保同一用户对同一 provider 只能有一条记录。`init_db()` 调用 `SQLModel.metadata.create_all(engine)` 时会自动建表，无需手动迁移。

- [ ] **Step 2: 验证表能被创建**

```bash
cd E:/XFusion-Agent/backend
python -c "
from app.core.database import init_db
init_db()
print('OK')
"
```

预期输出：`OK`（无报错）

- [ ] **Step 3: Commit**

```bash
git add backend/app/models/entities.py
git commit -m "feat: add ProviderKey entity for per-user LLM key storage"
```

---

## Task 2: 更新 API Schema

**Files:**
- Modify: `backend/app/schemas/api.py`

- [ ] **Step 1: 新增 Schema 类，并给 `TaskExecuteRequest` 加 `model` 字段**

打开 `backend/app/schemas/api.py`，在文件末尾添加：

```python
class ProviderKeyUpsertRequest(SQLModel):
    key: str

class ProviderInfo(SQLModel):
    provider_name: str
    display_name: str
    is_configured: bool
    models: list[str]
```

找到 `TaskExecuteRequest`，加一个可选字段：

```python
class TaskExecuteRequest(SQLModel):
    prompt: str
    session_id: str
    selected_host_ids: list[int]
    auto_approve: bool = False
    model: str | None = None          # 新增："provider/model-id"，None 用系统默认
```

- [ ] **Step 2: 验证 import 无报错**

```bash
cd E:/XFusion-Agent/backend
python -c "from app.schemas.api import ProviderKeyUpsertRequest, ProviderInfo, TaskExecuteRequest; print('OK')"
```

预期：`OK`

- [ ] **Step 3: Commit**

```bash
git add backend/app/schemas/api.py
git commit -m "feat: add ProviderKeyUpsertRequest, ProviderInfo schemas; add model field to TaskExecuteRequest"
```

---

## Task 3: LLM Router 支持 per-request API Key override

**Files:**
- Modify: `backend/app/services/llm_router.py`

- [ ] **Step 1: `OpenAICompatiblePlugin.chat_completion` 支持 `api_key_override`**

找到 `OpenAICompatiblePlugin.chat_completion` 方法，修改签名和第一行：

```python
async def chat_completion(
    self,
    *,
    model_id: str,
    messages: list[LLMMessage],
    max_tokens: int = 4096,
    timeout: int = 30,
    api_key_override: str | None = None,
) -> LLMResponse:
    api_key = api_key_override or self._get_api_key()
    model = self.normalize_model_id(model_id)
    # 后续代码不变
```

- [ ] **Step 2: `OpenAICompatiblePlugin.run_agent_loop` 同样支持 override**

找到 `OpenAICompatiblePlugin.run_agent_loop`，修改签名和第一行：

```python
async def run_agent_loop(
    self,
    *,
    model_id: str,
    messages: list[LLMMessage],
    tools: list[ToolDefinition],
    tool_executor: Callable[[str, dict[str, Any]], Awaitable[str]],
    max_turns: int = 10,
    max_tokens: int = 4096,
    timeout: int = 60,
    api_key_override: str | None = None,
) -> AgentLoopResult:
    api_key = api_key_override or self._get_api_key()
    model = self.normalize_model_id(model_id)
    # 后续代码不变
```

- [ ] **Step 3: `AnthropicNativePlugin.chat_completion` 同样支持 override**

找到 `AnthropicNativePlugin.chat_completion`，修改签名和第一行：

```python
async def chat_completion(
    self,
    *,
    model_id: str,
    messages: list[LLMMessage],
    max_tokens: int = 4096,
    timeout: int = 30,
    api_key_override: str | None = None,
) -> LLMResponse:
    api_key = api_key_override or os.environ[self._API_KEY_ENV]
    model = self.normalize_model_id(model_id)
    # 后续代码不变
```

- [ ] **Step 4: `AnthropicNativePlugin.run_agent_loop` 同样支持 override**

找到 `AnthropicNativePlugin.run_agent_loop`，修改签名和第一行：

```python
async def run_agent_loop(
    self,
    *,
    model_id: str,
    messages: list[LLMMessage],
    tools: list[ToolDefinition],
    tool_executor: Callable[[str, dict[str, Any]], Awaitable[str]],
    max_turns: int = 10,
    max_tokens: int = 4096,
    timeout: int = 60,
    api_key_override: str | None = None,
) -> AgentLoopResult:
    api_key = api_key_override or os.environ[self._API_KEY_ENV]
    model = self.normalize_model_id(model_id)
    # 后续代码不变
```

- [ ] **Step 5: `ProviderRegistry.chat_completion` 接收并传递 `api_keys`**

找到 `ProviderRegistry.chat_completion`，修改为：

```python
async def chat_completion(
    self,
    *,
    model: str,
    messages: list[LLMMessage],
    max_tokens: int = 4096,
    timeout: int = 30,
    api_keys: dict[str, str] | None = None,
) -> str:
    if "/" not in model:
        raise ValueError(f"XFUSION_MODEL must be 'provider/model-id' format, got: '{model}'")
    provider, model_id = model.split("/", 1)
    plugin = self.resolve(provider)
    api_key_override = (api_keys or {}).get(provider)
    response = await plugin.chat_completion(
        model_id=model_id,
        messages=messages,
        max_tokens=max_tokens,
        timeout=timeout,
        api_key_override=api_key_override,
    )
    return response.text
```

- [ ] **Step 6: `ProviderRegistry.agent_loop` 同样接收并传递 `api_keys`**

找到 `ProviderRegistry.agent_loop`，在签名中加 `api_keys: dict[str, str] | None = None`，并在调用 `plugin.run_agent_loop` 时传入：

```python
async def agent_loop(
    self,
    *,
    model: str,
    messages: list[LLMMessage],
    tools: list[ToolDefinition],
    tool_executor: Callable[[str, dict[str, Any]], Awaitable[str]],
    max_turns: int = 10,
    max_tokens: int = 4096,
    timeout: int = 60,
    api_keys: dict[str, str] | None = None,
) -> AgentLoopResult:
    if "/" not in model:
        raise ValueError(f"XFUSION_MODEL must be 'provider/model-id' format, got: '{model}'")
    provider, model_id = model.split("/", 1)
    plugin = self.resolve(provider)
    api_key_override = (api_keys or {}).get(provider)

    if not hasattr(plugin, "run_agent_loop"):
        supported = sorted(n for n, p in self._plugins.items() if hasattr(p, "run_agent_loop"))
        raise NotImplementedError(
            f"Provider '{provider}' does not support agent loop. "
            f"Providers with agent loop: {', '.join(supported)}"
        )

    return await plugin.run_agent_loop(
        model_id=model_id,
        messages=messages,
        tools=tools,
        tool_executor=tool_executor,
        max_turns=max_turns,
        max_tokens=max_tokens,
        timeout=timeout,
        api_key_override=api_key_override,
    )
```

- [ ] **Step 7: 新增 `ProviderRegistry.list_provider_info` 方法**

在 `ProviderRegistry` 类末尾追加：

```python
def list_provider_info(self) -> list[dict]:
    """返回所有 provider 的元数据，供 GET /providers 使用。"""
    result = []
    for name, plugin in sorted(self._plugins.items()):
        aliases = getattr(plugin, "_ALIASES", {})
        # 用 alias value（真实 model-id）构建选项，格式 "provider/model-id"
        if aliases:
            models = [f"{name}/{v}" for v in aliases.values()]
        else:
            models = []  # Ollama/特殊 provider 不预设模型列表
        result.append({
            "provider_name": name,
            "models": models,
            "env_key": getattr(plugin, "_API_KEY_ENV", ""),
        })
    return result
```

- [ ] **Step 8: 验证无语法错误**

```bash
cd E:/XFusion-Agent/backend
python -c "from app.services.llm_router import registry; print('providers:', len(registry.list_provider_info()))"
```

预期：`providers: 22`

- [ ] **Step 9: Commit**

```bash
git add backend/app/services/llm_router.py
git commit -m "feat: support per-request api_key override in llm_router ProviderRegistry"
```

---

## Task 4: Orchestrator 加载用户 Key 并传递模型

**Files:**
- Modify: `backend/app/services/orchestrator.py`

- [ ] **Step 1: `ClaudePlanner._run_json_query` 接收 `model` 和 `api_keys`**

找到 `ClaudePlanner._run_json_query`，修改签名和调用：

```python
@staticmethod
async def _run_json_query(
    *,
    prompt: str,
    system_prompt: str,
    max_turns: int = 2,
    timeout_seconds: int = 20,
    model: str | None = None,
    api_keys: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    if not settings.claude_enabled:
        return None
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
        return _extract_json_payload(text)
    except Exception:
        return None
```

- [ ] **Step 2: `ClaudePlanner.plan_task` 透传 `model` 和 `api_keys`**

找到 `ClaudePlanner.plan_task`，在签名中加两个参数，并传给 `_run_json_query`：

```python
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
    api_keys: dict[str, str] | None = None,
) -> IntentPlan | None:
    # ... 现有代码不变 ...
    result = await cls._run_json_query(
        prompt=f"User request:\n{prompt}\n\nExecution context:\n{json.dumps(payload, ensure_ascii=False)}",
        system_prompt=system_prompt,
        max_turns=2,
        timeout_seconds=20,
        model=model,
        api_keys=api_keys,
    )
    # 后续代码不变
```

- [ ] **Step 3: `ClaudePlanner.analyze_diagnosis` 透传**

找到 `ClaudePlanner.analyze_diagnosis`，加参数并传递：

```python
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
    api_keys: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    # ... 现有代码不变 ...
    return await cls._run_json_query(
        prompt=json.dumps(payload, ensure_ascii=False),
        system_prompt=system_prompt,
        max_turns=2,
        timeout_seconds=25,
        model=model,
        api_keys=api_keys,
    )
```

- [ ] **Step 4: `ClaudePlanner.explain_result` 透传**

找到 `ClaudePlanner.explain_result`，加参数并传递：

```python
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
    api_keys: dict[str, str] | None = None,
) -> str | None:
    # ... 现有代码不变 ...
    result = await cls._run_json_query(
        prompt=json.dumps(payload, ensure_ascii=False),
        system_prompt=system_prompt,
        max_turns=1,
        timeout_seconds=12,
        model=model,
        api_keys=api_keys,
    )
    # 后续代码不变
```

- [ ] **Step 5: `GoalDrivenOrchestrator` 加载用户 Key**

在 `GoalDrivenOrchestrator.__init__` 之后，新增一个私有方法：

```python
def _load_user_api_keys(self) -> dict[str, str]:
    from ..models.entities import ProviderKey
    from ..services.security import decrypt_secret
    rows = self.session.exec(
        select(ProviderKey).where(ProviderKey.user_id == self.user.id)
    ).all()
    return {row.provider_name: decrypt_secret(row.encrypted_key) for row in rows}
```

- [ ] **Step 6: `GoalDrivenOrchestrator.execute` 接收 `model` 并注入 Key**

找到 `execute` 方法签名，加 `model: str | None = None`：

```python
async def execute(
    self,
    prompt: str,
    session_id: str,
    selected_host_ids: list[int],
    auto_approve: bool,
    model: str | None = None,
) -> Task:
```

在方法开头（`if not selected_host_ids` 检查之后）加：

```python
    resolved_model = model or settings.model
    api_keys = self._load_user_api_keys()
```

- [ ] **Step 7: 将 `resolved_model` 和 `api_keys` 传入 `_build_plan`**

找到 `execute` 方法里 `plan = await self._build_plan(...)` 的调用，修改为：

```python
    plan = await self._build_plan(prompt, host, selected_host_ids, session_id, resolved_model, api_keys)
```

更新 `_build_plan` 签名：

```python
async def _build_plan(
    self,
    prompt: str,
    host: Host,
    selected_hosts: list[int],
    session_id: str,
    model: str | None = None,
    api_keys: dict[str, str] | None = None,
) -> IntentPlan:
```

在 `_build_plan` 中，把 `ClaudePlanner.plan_task(...)` 调用改为：

```python
    plan = await ClaudePlanner.plan_task(
        prompt=prompt,
        host=host,
        selected_host_ids=selected_hosts,
        session=self.session,
        session_id=session_id,
        model=model,
        api_keys=api_keys,
    )
```

- [ ] **Step 8: 将 `model`/`api_keys` 存入 `execute` 的局部变量并传给诊断/执行流程**

在 `execute` 方法里找到 `_run_diagnosis_flow` 和 `_run_act_and_verify` 的调用，传入新参数：

```python
# _run_diagnosis_flow 调用
return await self._run_diagnosis_flow(
    task=task,
    host=host,
    credential=credential,
    plan=plan,
    auto_approve=auto_approve,
    model=resolved_model,
    api_keys=api_keys,
)

# _run_act_and_verify 调用
return await self._run_act_and_verify(
    task=task, hosts=hosts, credentials=credentials, plan=plan,
    model=resolved_model, api_keys=api_keys,
)
```

更新 `_run_diagnosis_flow` 和 `_run_act_and_verify` 签名，加 `model` / `api_keys`，并透传给 `ClaudePlanner.analyze_diagnosis` / `ClaudePlanner.explain_result`：

`_run_diagnosis_flow` 签名：
```python
async def _run_diagnosis_flow(self, *, task, host, credential, plan, auto_approve,
                               model=None, api_keys=None) -> Task:
```

`_run_diagnosis_flow` 内 `analyze_diagnosis` 调用：
```python
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
```

`_run_act_and_verify` 签名：
```python
async def _run_act_and_verify(self, *, task, hosts, credentials, plan,
                               model=None, api_keys=None) -> Task:
```

`_run_act_and_verify` 内 `explain_result` 调用：
```python
    summary = await ClaudePlanner.explain_result(
        prompt=task.prompt,
        host=first_host,
        plan=plan,
        action_result=per_host_results[0]["action_result"],
        verification_result=per_host_results[0]["verification_result"],
        model=model,
        api_keys=api_keys,
    )
```

- [ ] **Step 9: 验证后端启动无报错**

```bash
cd E:/XFusion-Agent/backend
python -c "from app.services.orchestrator import GoalDrivenOrchestrator; print('OK')"
```

预期：`OK`

- [ ] **Step 10: Commit**

```bash
git add backend/app/services/orchestrator.py
git commit -m "feat: orchestrator loads per-user API keys and passes model/api_keys through planner"
```

---

## Task 5: 新增后端 Provider API 路由

**Files:**
- Modify: `backend/app/api/routes.py`

- [ ] **Step 1: 在 routes.py 顶部补充 import**

在现有 import 区域中确认并添加：

```python
from datetime import datetime, timezone
from ..models.entities import AgentNode, Approval, AuditLog, Host, ProviderKey, Service, Task, TaskStep, User
from ..schemas.api import (
    ...
    ProviderKeyUpsertRequest,
)
from ..services.llm_router import registry
from ..services.security import decrypt_secret, encrypt_secret
```

- [ ] **Step 2: 新增 `GET /providers` 路由**

在 `routes.py` 末尾添加：

```python
@router.get("/providers")
def list_providers(
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> list[dict]:
    user_keys = {
        row.provider_name
        for row in session.exec(
            select(ProviderKey).where(ProviderKey.user_id == current_user.id)
        ).all()
    }
    infos = registry.list_provider_info()
    result = []
    for info in infos:
        env_available = bool(info["env_key"] and os.environ.get(info["env_key"]))
        is_configured = info["provider_name"] in user_keys or env_available
        result.append({
            "provider_name": info["provider_name"],
            "is_configured": is_configured,
            "models": info["models"],
        })
    return result
```

> 注意：`os` 已在 orchestrator 中 import，但 routes.py 中需要确认顶部有 `import os`。

- [ ] **Step 3: 新增 `PUT /providers/{provider_name}/key` 路由**

```python
@router.put("/providers/{provider_name}/key")
def upsert_provider_key(
    provider_name: str,
    payload: ProviderKeyUpsertRequest,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    known = {info["provider_name"] for info in registry.list_provider_info()}
    if provider_name not in known:
        raise HTTPException(status_code=404, detail=f"未知 provider: {provider_name}")
    existing = session.exec(
        select(ProviderKey).where(
            ProviderKey.user_id == current_user.id,
            ProviderKey.provider_name == provider_name,
        )
    ).first()
    if existing:
        existing.encrypted_key = encrypt_secret(payload.key)
        existing.updated_at = datetime.now(timezone.utc)
        session.add(existing)
    else:
        session.add(ProviderKey(
            user_id=current_user.id,
            provider_name=provider_name,
            encrypted_key=encrypt_secret(payload.key),
            updated_at=datetime.now(timezone.utc),
        ))
    session.commit()
    return {"ok": True, "provider_name": provider_name}
```

- [ ] **Step 4: 新增 `DELETE /providers/{provider_name}/key` 路由**

```python
@router.delete("/providers/{provider_name}/key")
def delete_provider_key(
    provider_name: str,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    existing = session.exec(
        select(ProviderKey).where(
            ProviderKey.user_id == current_user.id,
            ProviderKey.provider_name == provider_name,
        )
    ).first()
    if not existing:
        raise HTTPException(status_code=404, detail="未配置该 provider 的 Key")
    session.delete(existing)
    session.commit()
    return {"ok": True}
```

- [ ] **Step 5: 更新 `execute_task` 路由，传入 `model`**

找到现有的 `execute_task` 路由：

```python
@router.post("/tasks/execute")
async def execute_task(
    payload: TaskExecuteRequest,
    session: Annotated[Session, Depends(get_session)],
    current_user: Annotated[User, Depends(get_current_user)],
) -> dict:
    orchestrator = GoalDrivenOrchestrator(session, current_user)
    task = await orchestrator.execute(
        payload.prompt,
        payload.session_id,
        payload.selected_host_ids,
        payload.auto_approve,
        model=payload.model,        # 新增
    )
    return serialize_model(task)
```

- [ ] **Step 6: 验证后端启动并访问文档**

```bash
cd E:/XFusion-Agent/backend
uvicorn app.main:app --reload --port 8000
```

打开 `http://localhost:8000/docs`，确认能看到 `/providers`（GET/PUT/DELETE）三个新端点。

- [ ] **Step 7: 用 curl 测试 GET /providers（需先登录拿 token）**

```bash
TOKEN="your_jwt_token_here"
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/providers | python -m json.tool | head -40
```

预期：返回 22 个 provider 的 JSON 数组，每项含 `provider_name`、`is_configured`、`models`。

- [ ] **Step 8: Commit**

```bash
git add backend/app/api/routes.py
git commit -m "feat: add GET/PUT/DELETE /providers routes for per-user API key management"
```

---

## Task 6: 前端 api.ts 新增 Provider 函数

**Files:**
- Modify: `frontend/src/services/api.ts`

- [ ] **Step 1: 新增类型定义和 API 函数**

在 `api.ts` 末尾追加：

```typescript
export interface ProviderInfo {
  provider_name: string
  is_configured: boolean
  models: string[]
}

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const { data } = await api.get('/providers')
  return data
}

export async function upsertProviderKey(providerName: string, key: string): Promise<void> {
  await api.put(`/providers/${providerName}/key`, { key })
}

export async function deleteProviderKey(providerName: string): Promise<void> {
  await api.delete(`/providers/${providerName}/key`)
}
```

- [ ] **Step 2: 更新 `executeTask` 的 payload 类型注释**

`executeTask` 目前接受 `Record<string, unknown>`，无需改类型签名，调用方直接传 `model` 字段即可。

- [ ] **Step 3: 验证 TypeScript 编译**

```bash
cd E:/XFusion-Agent/frontend
npx tsc --noEmit
```

预期：无报错。

- [ ] **Step 4: Commit**

```bash
git add frontend/src/services/api.ts
git commit -m "feat: add fetchProviders, upsertProviderKey, deleteProviderKey to api.ts"
```

---

## Task 7: Settings 页面新增"AI 模型配置"卡片

**Files:**
- Modify: `frontend/src/pages/SettingsPage.tsx`

- [ ] **Step 1: 新增 import**

在 `SettingsPage.tsx` 顶部 import 区，加入：

```typescript
import { CheckCircleFilled, MinusCircleOutlined } from '@ant-design/icons'
import { ProviderInfo, deleteProviderKey, fetchProviders, upsertProviderKey } from '../services/api'
```

- [ ] **Step 2: 在组件内新增 provider key 相关 state 和 queries**

在 `SettingsPage` 函数体内，现有 `useQuery` 之后加：

```typescript
const { data: providers = [], refetch: refetchProviders } = useQuery<ProviderInfo[]>({
  queryKey: ['providers'],
  queryFn: fetchProviders,
})

const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})

const upsertKeyMutation = useMutation({
  mutationFn: ({ name, key }: { name: string; key: string }) => upsertProviderKey(name, key),
  onSuccess: (_, { name }) => {
    messageApi.success(`${name} Key 已保存`)
    setKeyInputs((prev) => ({ ...prev, [name]: '' }))
    refetchProviders()
  },
  onError: (error: any) => {
    messageApi.error(error?.response?.data?.detail ?? 'Key 保存失败')
  },
})

const deleteKeyMutation = useMutation({
  mutationFn: (name: string) => deleteProviderKey(name),
  onSuccess: (_, name) => {
    messageApi.success(`${name} Key 已删除`)
    refetchProviders()
  },
  onError: (error: any) => {
    messageApi.error(error?.response?.data?.detail ?? 'Key 删除失败')
  },
})
```

- [ ] **Step 3: 在 JSX 中新增"AI 模型配置"卡片**

找到 `<div className="panel-subgrid panel-subgrid--2">` 中"内建动作"卡片的父 div，在其后追加一个同级的 `<div className="panel-subgrid panel-subgrid--2">`：

```tsx
<div className="panel-subgrid panel-subgrid--2">
  <Card
    type="inner"
    className="panel-subcard resizable-subcard"
    title="AI 模型配置"
  >
    <div className="panel-subcard__content">
      <Typography.Text type="secondary">
        为每个 Provider 配置你自己的 API Key，配置后可在 Agent 面板切换模型。
      </Typography.Text>
      <List
        dataSource={providers}
        renderItem={(provider) => (
          <List.Item
            actions={[
              <Button
                key="save"
                size="small"
                type="primary"
                disabled={!keyInputs[provider.provider_name]}
                loading={upsertKeyMutation.isPending}
                onClick={() =>
                  upsertKeyMutation.mutate({
                    name: provider.provider_name,
                    key: keyInputs[provider.provider_name] ?? '',
                  })
                }
              >
                保存
              </Button>,
              provider.is_configured ? (
                <Button
                  key="delete"
                  size="small"
                  danger
                  loading={deleteKeyMutation.isPending}
                  onClick={() => deleteKeyMutation.mutate(provider.provider_name)}
                >
                  删除
                </Button>
              ) : null,
            ].filter(Boolean)}
          >
            <List.Item.Meta
              avatar={
                provider.is_configured ? (
                  <CheckCircleFilled style={{ color: '#52c41a', fontSize: 16 }} />
                ) : (
                  <MinusCircleOutlined style={{ color: '#d9d9d9', fontSize: 16 }} />
                )
              }
              title={provider.provider_name}
              description={
                <Input.Password
                  size="small"
                  placeholder={provider.is_configured ? '已配置，输入新值可覆盖' : '粘贴 API Key'}
                  value={keyInputs[provider.provider_name] ?? ''}
                  onChange={(e) =>
                    setKeyInputs((prev) => ({
                      ...prev,
                      [provider.provider_name]: e.target.value,
                    }))
                  }
                  style={{ maxWidth: 300 }}
                />
              }
            />
          </List.Item>
        )}
      />
    </div>
  </Card>
</div>
```

- [ ] **Step 4: 验证 TypeScript 编译**

```bash
cd E:/XFusion-Agent/frontend
npx tsc --noEmit
```

预期：无报错。

- [ ] **Step 5: 启动前端检查页面**

```bash
cd E:/XFusion-Agent/frontend
npm run dev
```

打开 `http://localhost:5173`，进入 Settings 页，确认"AI 模型配置"卡片显示，每行有 provider 名、输入框、保存按钮，已配置的行有绿点和删除按钮。

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/SettingsPage.tsx
git commit -m "feat: add AI model config card to SettingsPage with per-provider key management"
```

---

## Task 8: AgentPanel 新增模型选择下拉

**Files:**
- Modify: `frontend/src/components/AgentPanel.tsx`

- [ ] **Step 1: 新增 import**

在 `AgentPanel.tsx` 顶部 import 中加入：

```typescript
import { ProviderInfo, fetchProviders } from '../services/api'
```

并在 antd import 中加 `Select`（如果不存在）。

- [ ] **Step 2: 新增 model state 和 providers query**

在 `AgentPanel` 函数体内现有 state 之后加：

```typescript
const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined)

const { data: providers = [] } = useQuery<ProviderInfo[]>({
  queryKey: ['providers'],
  queryFn: fetchProviders,
})

const modelOptions = useMemo(() => {
  const configured = providers.filter((p) => p.is_configured && p.models.length > 0)
  return configured.map((p) => ({
    label: p.provider_name,
    options: p.models.map((m) => ({ label: m, value: m })),
  }))
}, [providers])
```

- [ ] **Step 3: 在 `runPrompt` 中带上 `selectedModel`**

找到 `executeMutation.mutate({...})` 调用，加 `model` 字段：

```typescript
executeMutation.mutate({
  prompt,
  selected_host_ids: selectedHosts,
  session_id: sessionId,
  auto_approve: false,
  model: selectedModel ?? null,
})
```

- [ ] **Step 4: 在按钮行加 Select 下拉**

找到输入区底部的 `<Space style={{ width: '100%', justifyContent: 'space-between' }}>` 块，在语音输入按钮和发送按钮之间插入：

```tsx
<Select
  size="small"
  allowClear
  placeholder="默认模型"
  value={selectedModel}
  onChange={setSelectedModel}
  options={modelOptions}
  style={{ width: 200 }}
  popupMatchSelectWidth={false}
/>
```

整个 Space 块改为：

```tsx
<Space style={{ width: '100%', justifyContent: 'space-between' }}>
  <Button icon={<AudioOutlined />} onClick={startVoiceInput} loading={listening}>
    {listening ? '正在听写' : '语音输入'}
  </Button>
  <Space>
    <Select
      size="small"
      allowClear
      placeholder="默认模型"
      value={selectedModel}
      onChange={setSelectedModel}
      options={modelOptions}
      style={{ width: 200 }}
      popupMatchSelectWidth={false}
    />
    <Button
      type="primary"
      icon={<PlayCircleOutlined />}
      disabled={!canExecute}
      loading={executeMutation.isPending}
      onClick={runPrompt}
    >
      发送给 Agent
    </Button>
  </Space>
</Space>
```

- [ ] **Step 5: 验证 TypeScript 编译**

```bash
cd E:/XFusion-Agent/frontend
npx tsc --noEmit
```

预期：无报错。

- [ ] **Step 6: 浏览器验证**

1. 先在 Settings 页面为某个 provider（如 deepseek）填入 Key 并保存
2. 回到主页面 AgentPanel
3. 确认"发送给 Agent"左侧出现模型 Select
4. 点开 Select，确认只显示已配置 Key 的 provider 的模型
5. 选择一个模型，发送任务，确认任务正常提交

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/AgentPanel.tsx
git commit -m "feat: add model selector to AgentPanel, sends selected model with task"
```

---

## 自查清单

- [x] **ProviderKey 实体** — Task 1 实现
- [x] **Schema 类型** — Task 2 实现（`ProviderKeyUpsertRequest`、`TaskExecuteRequest.model`）
- [x] **LLM Router override** — Task 3 实现（`OpenAICompatiblePlugin`、`AnthropicNativePlugin`、`ProviderRegistry`）
- [x] **Orchestrator 用户 Key 加载** — Task 4 实现
- [x] **3 个 Provider 路由** — Task 5 实现
- [x] **前端 api.ts** — Task 6 实现
- [x] **Settings 配置卡** — Task 7 实现
- [x] **AgentPanel 模型 Select** — Task 8 实现
- [x] **安全：Key 只加密存储，API 不返回明文** — `GET /providers` 只返回 `is_configured: bool`
- [x] **Ollama（无 Key）** — `env_key=""` 时 `is_available()` 返回 `True`，不影响逻辑
- [x] **Wenxin（双 Key）** — 仍通过 env var 配置，UI 中 `is_configured` 由 `env_available` 决定，无输入框问题
