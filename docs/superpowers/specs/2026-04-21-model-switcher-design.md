# 模型切换与 API Key 管理功能设计

**日期：** 2026-04-21
**状态：** 已审批，待实现

---

## 目标

1. 用户可以在 Settings 页面为每个 LLM provider 配置自己的 API Key（每用户独立存储）
2. Agent 对话界面（AgentPanel）有一个小的模型选择下拉，仅列出当前用户已配置 Key 的 provider 的模型选项
3. 任务执行时使用用户选择的模型，未选则 fallback 到系统默认（`settings.model`）

---

## 后端

### 1. 数据模型 — `ProviderKey`

新增 SQLModel 实体，加入 `backend/app/models/entities.py`：

```
ProviderKey
  id:             int (PK)
  user_id:        int (FK → User.id)
  provider_name:  str           # e.g. "anthropic", "deepseek"
  encrypted_key:  str           # Fernet 加密
  updated_at:     datetime
唯一约束: (user_id, provider_name)
```

加解密使用现有 `security.py` 的 `encrypt_secret` / `decrypt_secret`。

### 2. API Schema — 新增字段

`backend/app/schemas/api.py` 新增：

```python
class ProviderKeyUpsertRequest(BaseModel):
    key: str

class ProviderInfo(BaseModel):
    provider_name: str
    display_name: str
    is_configured: bool          # 当前用户是否已存 Key（或 env var 存在）
    models: list[str]            # 该 provider 的预设模型 id 列表（来自 _ALIASES + 默认）
```

`TaskExecuteRequest` 新增可选字段：

```python
model: str | None = None         # "provider/model-id" 格式，None 则用 settings.model
```

### 3. API 路由 — 3 个新端点（`routes.py`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/providers` | 列出所有 provider 及当前用户配置状态 |
| PUT | `/providers/{provider_name}/key` | 保存/更新当前用户的 Key |
| DELETE | `/providers/{provider_name}/key` | 删除当前用户的 Key |

所有端点都需要 `get_current_user` 鉴权。

### 4. LLM Router — 支持 Key Override

`llm_router.py` 改造：

- `OpenAICompatiblePlugin._get_api_key(override)` / `AnthropicNativePlugin` 同样：优先用 `override`，无则读 `os.environ`
- `ProviderRegistry.chat_completion(... api_keys: dict[str, str] = {})` — 将对应 provider 的 key 传入 plugin
- `ProviderRegistry.agent_loop(... api_keys: dict[str, str] = {})` — 同上
- `is_available(user_keys: dict[str, str] = {})` — 先查 `user_keys`，再查 env var

### 5. Orchestrator — 加载用户 Key

`GoalDrivenOrchestrator.execute()` 执行前：
1. 查询 `ProviderKey` 表，取出当前用户所有 Key，解密为 `{provider_name: key}` 字典
2. 用 `payload.model or settings.model` 决定模型
3. 将 `api_keys` 字典传入所有 `registry.chat_completion()` 和 `registry.agent_loop()` 调用
4. `ClaudePlanner` 的静态方法需接收并透传 `api_keys`

---

## 前端

### 1. `api.ts` — 新增 API 函数

```typescript
fetchProviders(): ProviderInfo[]
upsertProviderKey(providerName: string, key: string): void
deleteProviderKey(providerName: string): void
```

`executeTask` 的 payload 新增可选 `model?: string`。

### 2. Settings 页面 — 新增"AI 模型配置"卡片

位置：现有"内建动作"卡片旁边（两列布局中的第二行）

每行展示一个 provider：
- 绿点（已配置）/ 灰点（未配置）
- Provider 名称
- `Input.Password` 输入框（已配置时 placeholder 为 `••••••••`，可重新输入覆盖）
- 保存按钮 / 已配置时额外显示删除按钮

加载时调用 `GET /providers`，保存/删除后 invalidate query 刷新列表。

### 3. AgentPanel — 模型选择下拉

位置：输入区底部按钮行，在"发送给 Agent"按钮左侧

实现：
- `Select` 组件，`size="small"`，`style={{ width: 200 }}`
- Options 来源：`GET /providers` 过滤 `is_configured === true`，将每个 provider 的 `models` 展开为 `provider/model-id` 选项，按 provider 分组（`OptGroup`）
- 初始值：`settings.model`（从 `/providers` 接口附带返回当前系统默认）
- 选中值存 `useState`，随 `executeMutation.mutate` payload 一起发出

---

## 数据流

```
用户选模型 → AgentPanel state(model)
     ↓
executeTask({ ..., model: "deepseek/deepseek-chat" })
     ↓
POST /tasks/execute
     ↓
Orchestrator:
  1. 查 ProviderKey 表 → api_keys = {"deepseek": "sk-xxx"}
  2. model = "deepseek/deepseek-chat"
  3. ClaudePlanner._run_json_query(api_keys=api_keys, model=model)
     ↓
ProviderRegistry.chat_completion(model="deepseek/deepseek-chat", api_keys={"deepseek": "sk-xxx"})
     ↓
DeepSeekPlugin._get_api_key(override="sk-xxx") → "sk-xxx"
```

---

## 安全约束

- API Key 只加密存储，`GET /providers` 不返回明文 Key，只返回 `is_configured: bool`
- 用户只能读写自己的 Key（路由层通过 `current_user.id` 过滤）
- 前端输入框使用 `Input.Password`，防止肩窥

---

## 不在范围内

- 管理员查看/覆盖他人的 Key
- 自定义 provider（只支持已注册的 22 个）
- Key 有效性验证（保存时不发测试请求）
