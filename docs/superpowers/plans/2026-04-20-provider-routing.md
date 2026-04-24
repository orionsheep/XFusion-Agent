# Multi-Model Provider Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 替换 `claude_agent_sdk` 的规划调用，实现 OpenClaw 风格 Provider Plugin 系统，支持通过 `XFUSION_MODEL=provider/model-id` 切换任意模型。

**Architecture:** 新建 `llm_router.py` 定义 `ProviderPlugin` Protocol 和五个内置插件（Anthropic、Zhipu、OpenAI、Gemini、Ollama），每个插件用 `httpx` 直接调用对应 API。`ProviderRegistry` 在启动时解析 `XFUSION_MODEL` 并返回就绪的 client。`orchestrator.py` 和 `platform.py` 把 `claude_agent_sdk.query()` 换成 `registry.chat_completion()`。

**Tech Stack:** Python 3.11+, httpx (已有依赖), pydantic-settings (已有依赖)

---

## File Map

| 文件 | 操作 | 说明 |
|------|------|------|
| `backend/app/services/llm_router.py` | **新建** | 全部 plugin 逻辑 |
| `backend/app/core/config.py` | **修改** | `claude_model` → `model` |
| `backend/app/services/orchestrator.py` | **修改** | 替换 `_run_json_query()`，更新 import |
| `backend/app/services/platform.py` | **修改** | 替换 `maybe_summarize()`，更新 import |
| `backend/.env.example` | **修改** | 更新示例 |

---

## Task 1: 新建 `llm_router.py` — 基础类型与 Protocol

**Files:**
- Create: `backend/app/services/llm_router.py`

- [ ] **Step 1: 创建文件，写入基础类型和 Protocol**

```python
# backend/app/services/llm_router.py
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


@dataclass
class LLMMessage:
    role: str   # "system" | "user" | "assistant"
    content: str


@dataclass
class LLMResponse:
    text: str
    provider: str
    model_id: str


@runtime_checkable
class ProviderPlugin(Protocol):
    provider_name: str

    async def chat_completion(
        self,
        *,
        model_id: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 30,
    ) -> LLMResponse:
        ...

    def normalize_model_id(self, model_id: str) -> str:
        ...

    def is_available(self) -> bool:
        """返回 False 时 registry 跳过此 provider"""
        ...
```

- [ ] **Step 2: commit**

```bash
git add backend/app/services/llm_router.py
git commit -m "feat: scaffold llm_router base types and ProviderPlugin protocol"
```

---

## Task 2: AnthropicPlugin

**Files:**
- Modify: `backend/app/services/llm_router.py`

- [ ] **Step 1: 追加 AnthropicPlugin**

在 `llm_router.py` 末尾添加：

```python
import httpx


class AnthropicPlugin:
    provider_name = "anthropic"
    _BASE_URL = "https://api.anthropic.com/v1/messages"
    _VERSION = "2023-06-01"

    def normalize_model_id(self, model_id: str) -> str:
        aliases = {
            "opus":   "claude-opus-4-7",
            "sonnet": "claude-sonnet-4-6",
            "haiku":  "claude-haiku-4-5-20251001",
        }
        return aliases.get(model_id, model_id)

    def is_available(self) -> bool:
        return bool(os.getenv("ANTHROPIC_API_KEY"))

    async def chat_completion(
        self,
        *,
        model_id: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 30,
    ) -> LLMResponse:
        api_key = os.environ["ANTHROPIC_API_KEY"]
        model = self.normalize_model_id(model_id)

        # Anthropic format: system 单独提取，其余放 messages
        system = next((m.content for m in messages if m.role == "system"), "")
        user_messages = [
            {"role": m.role, "content": m.content}
            for m in messages if m.role != "system"
        ]

        body: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": user_messages,
        }
        if system:
            body["system"] = system

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                self._BASE_URL,
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": self._VERSION,
                    "content-type": "application/json",
                },
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["content"][0]["text"]
            return LLMResponse(text=text, provider="anthropic", model_id=model)
```

- [ ] **Step 2: commit**

```bash
git add backend/app/services/llm_router.py
git commit -m "feat: add AnthropicPlugin with model alias support"
```

---

## Task 3: ZhipuPlugin

**Files:**
- Modify: `backend/app/services/llm_router.py`

- [ ] **Step 1: 追加 ZhipuPlugin**

Zhipu 的端点兼容 Anthropic 格式，直接继承相同逻辑，只换 base_url 和 key。

在 `AnthropicPlugin` 之后添加：

```python
class ZhipuPlugin:
    provider_name = "zhipu"
    _BASE_URL = "https://open.bigmodel.cn/api/anthropic/v1/messages"
    _VERSION = "2023-06-01"

    def normalize_model_id(self, model_id: str) -> str:
        aliases = {
            "glm4":     "glm-4.7",
            "glm4air":  "glm-4.5-air",
            "glm4flash": "glm-4.5-flash",
        }
        return aliases.get(model_id, model_id)

    def is_available(self) -> bool:
        return bool(os.getenv("ZHIPU_API_KEY"))

    async def chat_completion(
        self,
        *,
        model_id: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 30,
    ) -> LLMResponse:
        api_key = os.environ["ZHIPU_API_KEY"]
        model = self.normalize_model_id(model_id)

        system = next((m.content for m in messages if m.role == "system"), "")
        user_messages = [
            {"role": m.role, "content": m.content}
            for m in messages if m.role != "system"
        ]

        body: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": user_messages,
        }
        if system:
            body["system"] = system

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                self._BASE_URL,
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": self._VERSION,
                    "content-type": "application/json",
                },
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["content"][0]["text"]
            return LLMResponse(text=text, provider="zhipu", model_id=model)
```

- [ ] **Step 2: commit**

```bash
git add backend/app/services/llm_router.py
git commit -m "feat: add ZhipuPlugin (Anthropic-compatible endpoint)"
```

---

## Task 4: OpenAIPlugin 和 OllamaPlugin

**Files:**
- Modify: `backend/app/services/llm_router.py`

- [ ] **Step 1: 追加 OpenAIPlugin**

```python
class OpenAIPlugin:
    provider_name = "openai"
    _BASE_URL = "https://api.openai.com/v1/chat/completions"

    def normalize_model_id(self, model_id: str) -> str:
        return model_id  # 直接用原始 model id

    def is_available(self) -> bool:
        return bool(os.getenv("OPENAI_API_KEY"))

    async def chat_completion(
        self,
        *,
        model_id: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 30,
    ) -> LLMResponse:
        api_key = os.environ["OPENAI_API_KEY"]

        body = {
            "model": model_id,
            "max_tokens": max_tokens,
            "messages": [
                {"role": m.role, "content": m.content} for m in messages
            ],
        }

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                self._BASE_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "content-type": "application/json",
                },
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            return LLMResponse(text=text, provider="openai", model_id=model_id)
```

- [ ] **Step 2: 追加 OllamaPlugin**

```python
class OllamaPlugin:
    provider_name = "ollama"

    def __init__(self) -> None:
        self._base_url = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")

    def normalize_model_id(self, model_id: str) -> str:
        return model_id

    def is_available(self) -> bool:
        return True  # 本地服务，无需 key

    async def chat_completion(
        self,
        *,
        model_id: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 60,
    ) -> LLMResponse:
        body = {
            "model": model_id,
            "messages": [
                {"role": m.role, "content": m.content} for m in messages
            ],
            "stream": False,
            "options": {"num_predict": max_tokens},
        }

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{self._base_url}/api/chat",
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["message"]["content"]
            return LLMResponse(text=text, provider="ollama", model_id=model_id)
```

- [ ] **Step 3: commit**

```bash
git add backend/app/services/llm_router.py
git commit -m "feat: add OpenAIPlugin and OllamaPlugin"
```

---

## Task 5: GeminiPlugin

**Files:**
- Modify: `backend/app/services/llm_router.py`

- [ ] **Step 1: 追加 GeminiPlugin**

```python
class GeminiPlugin:
    provider_name = "gemini"
    _BASE = "https://generativelanguage.googleapis.com/v1beta/models"

    def normalize_model_id(self, model_id: str) -> str:
        aliases = {
            "flash": "gemini-2.0-flash",
            "pro":   "gemini-2.0-pro",
        }
        return aliases.get(model_id, model_id)

    def is_available(self) -> bool:
        return bool(os.getenv("GEMINI_API_KEY"))

    async def chat_completion(
        self,
        *,
        model_id: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 30,
    ) -> LLMResponse:
        api_key = os.environ["GEMINI_API_KEY"]
        model = self.normalize_model_id(model_id)
        url = f"{self._BASE}/{model}:generateContent?key={api_key}"

        system = next((m.content for m in messages if m.role == "system"), "")
        contents = [
            {"role": "user" if m.role == "user" else "model",
             "parts": [{"text": m.content}]}
            for m in messages if m.role != "system"
        ]

        body: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"maxOutputTokens": max_tokens},
        }
        if system:
            body["system_instruction"] = {"parts": [{"text": system}]}

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                url,
                headers={"content-type": "application/json"},
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return LLMResponse(text=text, provider="gemini", model_id=model)
```

- [ ] **Step 2: commit**

```bash
git add backend/app/services/llm_router.py
git commit -m "feat: add GeminiPlugin"
```

---

## Task 6: ProviderRegistry

**Files:**
- Modify: `backend/app/services/llm_router.py`

- [ ] **Step 1: 追加 ProviderRegistry**

```python
class ProviderRegistry:
    def __init__(self) -> None:
        self._plugins: dict[str, ProviderPlugin] = {}
        for plugin in [
            AnthropicPlugin(),
            ZhipuPlugin(),
            OpenAIPlugin(),
            GeminiPlugin(),
            OllamaPlugin(),
        ]:
            self._plugins[plugin.provider_name] = plugin  # type: ignore[index]

    def register(self, plugin: ProviderPlugin) -> None:
        self._plugins[plugin.provider_name] = plugin  # type: ignore[index]

    def resolve(self, provider: str) -> ProviderPlugin:
        plugin = self._plugins.get(provider)
        if plugin is None:
            supported = ", ".join(self._plugins)
            raise ValueError(
                f"Unknown provider '{provider}'. Supported: {supported}"
            )
        return plugin

    async def chat_completion(
        self,
        *,
        model: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 30,
    ) -> str:
        """
        model 格式: "provider/model-id"，如 "zhipu/glm-4.7"
        返回纯文本，供调用方解析 JSON。
        """
        if "/" not in model:
            raise ValueError(
                f"XFUSION_MODEL must be in 'provider/model-id' format, got: '{model}'"
            )
        provider, model_id = model.split("/", 1)
        plugin = self.resolve(provider)
        response = await plugin.chat_completion(
            model_id=model_id,
            messages=messages,
            max_tokens=max_tokens,
            timeout=timeout,
        )
        return response.text


# 全局单例，模块加载时初始化
registry = ProviderRegistry()
```

- [ ] **Step 2: commit**

```bash
git add backend/app/services/llm_router.py
git commit -m "feat: add ProviderRegistry with global singleton"
```

---

## Task 7: 更新 config.py

**Files:**
- Modify: `backend/app/core/config.py`

- [ ] **Step 1: 替换 claude_model 字段**

当前内容：
```python
claude_enabled: bool = True
claude_model: str = "sonnet"
```

改为：
```python
claude_enabled: bool = True
model: str = "anthropic/claude-sonnet-4-6"
```

- [ ] **Step 2: 更新 .env.example**

`backend/.env.example` 当前有：
```
XFUSION_CLAUDE_MODEL=sonnet
```

替换为：
```
# 格式: provider/model-id
# 支持: anthropic / zhipu / openai / gemini / ollama
XFUSION_MODEL=anthropic/claude-sonnet-4-6

# 对应 provider 的 API Key
ANTHROPIC_API_KEY=sk-ant-...
# ZHIPU_API_KEY=...
# OPENAI_API_KEY=sk-...
# GEMINI_API_KEY=...
# OLLAMA_BASE_URL=http://localhost:11434  (可选，默认值)
```

- [ ] **Step 3: commit**

```bash
git add backend/app/core/config.py backend/.env.example
git commit -m "feat: replace claude_model with model in provider/model-id format"
```

---

## Task 8: 更新 orchestrator.py

**Files:**
- Modify: `backend/app/services/orchestrator.py`

- [ ] **Step 1: 更新 import，删除 claude_agent_sdk 引用**

文件顶部找到：
```python
from claude_agent_sdk import ClaudeAgentOptions, query
```

替换为：
```python
from .llm_router import LLMMessage, registry
```

- [ ] **Step 2: 删除 `_has_claude_credentials()` 函数**

找到并删除整个函数（第 53-57 行）：
```python
def _has_claude_credentials() -> bool:
    return any(
        os.getenv(name)
        for name in ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]
    )
```

- [ ] **Step 3: 替换 `ClaudePlanner._run_json_query()`**

找到整个 `_run_json_query` 方法（第 130-165 行），替换为：

```python
@staticmethod
async def _run_json_query(
    *,
    prompt: str,
    system_prompt: str,
    max_turns: int = 2,   # 保留参数签名兼容性，忽略值
    timeout_seconds: int = 20,
) -> dict[str, Any] | None:
    if not settings.claude_enabled:
        return None
    try:
        text = await registry.chat_completion(
            model=settings.model,
            messages=[
                LLMMessage(role="system", content=system_prompt),
                LLMMessage(role="user", content=prompt),
            ],
            timeout=timeout_seconds,
        )
        return _extract_json_payload(text)
    except Exception:
        return None
```

- [ ] **Step 4: 找到 `plan_task` 中 `planning_source="claude"` 改为动态值**

找到 `planning_source="claude"` 这一行，替换为：

```python
planning_source=settings.model.split("/")[0],
```

- [ ] **Step 5: commit**

```bash
git add backend/app/services/orchestrator.py
git commit -m "feat: replace claude_agent_sdk.query with registry.chat_completion in orchestrator"
```

---

## Task 9: 更新 platform.py

**Files:**
- Modify: `backend/app/services/platform.py`

- [ ] **Step 1: 更新 import，删除 claude_agent_sdk 引用**

找到：
```python
from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool
```

替换为（只删除 claude_agent_sdk 这行，其他 import 不动）：

```python
from .llm_router import LLMMessage, registry
```

注意：如果同文件其他地方还用到了 `tool` 或 `create_sdk_mcp_server`，先搜索确认后再删。

- [ ] **Step 2: 替换 `ClaudePlanner.maybe_summarize()`**

找到整个 `maybe_summarize` 方法（第 651-684 行），替换为：

```python
@staticmethod
async def maybe_summarize(
    prompt: str, context: dict[str, Any], session: Session
) -> dict[str, Any] | None:
    if not settings.claude_enabled:
        return None
    try:
        system_prompt = (
            "You are an operations planner. Convert the user request into JSON with "
            "keys summary, risk_hint, target_guess. Return concise JSON only."
        )
        user_content = (
            f"User request: {prompt}\n"
            f"Context: {json.dumps(context, ensure_ascii=False)}"
        )
        text = await registry.chat_completion(
            model=settings.model,
            messages=[
                LLMMessage(role="system", content=system_prompt),
                LLMMessage(role="user", content=user_content),
            ],
            timeout=8,
        )
        return {"raw": text}
    except Exception:
        return None
```

- [ ] **Step 3: 搜索 platform.py 中其他 claude_agent_sdk 用法**

```bash
grep -n "claude_agent_sdk\|ClaudeAgentOptions\|create_sdk_mcp_server\|from claude" \
  backend/app/services/platform.py
```

如有遗漏逐一删除或替换。

- [ ] **Step 4: commit**

```bash
git add backend/app/services/platform.py
git commit -m "feat: replace claude_agent_sdk usage in platform.py"
```

---

## Task 10: 验证启动与冒烟测试

**Files:** 无新增

- [ ] **Step 1: 检查 import 干净**

```bash
grep -rn "claude_agent_sdk" backend/app/services/
```

期望输出：空（无任何匹配）

- [ ] **Step 2: 设置环境变量，启动后端**

```bash
cd backend
export XFUSION_MODEL=anthropic/claude-sonnet-4-6
export ANTHROPIC_API_KEY=your-key-here
python -m uvicorn app.main:app --reload --port 8000
```

期望：启动成功，无 ImportError

- [ ] **Step 3: 用 curl 触发一次规划调用**

```bash
# 先登录拿 token
curl -s -X POST http://localhost:8000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}' | python -m json.tool

# 用拿到的 token 发一个 task（替换 YOUR_TOKEN 和 HOST_ID）
curl -s -X POST http://localhost:8000/api/tasks \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"查看磁盘使用情况","host_id":HOST_ID}' | python -m json.tool
```

期望：返回包含 `action_type`, `title` 的 JSON，`planning_source` 为 `"anthropic"`

- [ ] **Step 4: 切换到智谱验证**

```bash
export XFUSION_MODEL=zhipu/glm-4.7
export ZHIPU_API_KEY=your-zhipu-key
# 重启后端，重复 Step 3
# 期望: planning_source 为 "zhipu"
```

- [ ] **Step 5: 最终 commit**

```bash
git add .
git commit -m "feat: complete multi-model provider routing via plugin system"
```

---

## 自检

- [x] spec 第 5 节所有文件均有对应 task
- [x] 无 TBD / TODO
- [x] `LLMMessage` 在 Task 1 定义，Task 8/9 使用时一致
- [x] `registry.chat_completion()` 签名在 Task 6 定义，Task 8/9 调用参数匹配
- [x] `claude-agent-sdk` 依赖保留在 `pyproject.toml`（未修改）
- [x] `settings.model` 在 Task 7 定义，Task 8 使用一致
