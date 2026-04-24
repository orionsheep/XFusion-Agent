# Multi-Model Provider Routing — Design Spec

**Date:** 2026-04-20  
**Status:** Approved  
**Scope:** `backend/` only — frontend, SSH execution, approval, audit untouched

---

## 1. 背景与目标

XFusion-Agent 当前硬绑定 `claude_agent_sdk`，模型由 `XFUSION_CLAUDE_MODEL=sonnet` 控制，仅支持 Anthropic 系列。

目标：实现 OpenClaw 风格的 Provider Plugin 系统，让任意兼容模型（智谱 GLM、OpenAI、Gemini、Ollama 等）可通过单行配置接入，`claude_agent_sdk` 完全保留。

---

## 2. 配置格式

```bash
# .env
XFUSION_MODEL=anthropic/claude-sonnet-4-6   # 默认
XFUSION_MODEL=zhipu/glm-4.7
XFUSION_MODEL=openai/gpt-4o
XFUSION_MODEL=gemini/gemini-2.0-flash
XFUSION_MODEL=ollama/llama3
```

格式：`provider/model-id`，启动时由 `ProviderRegistry` 解析。

---

## 3. 架构

```
启动时
  XFUSION_MODEL="zhipu/glm-4.7"
       ↓
  ProviderRegistry.resolve("zhipu", "glm-4.7")
       ↓
  ZhipuPlugin.normalize_transport()
       → base_url = "https://open.bigmodel.cn/api/anthropic"
       → api_key  = os.environ["ZHIPU_API_KEY"]
       ↓
  os.environ["ANTHROPIC_BASE_URL"] = base_url
  os.environ["ANTHROPIC_API_KEY"]  = api_key
       ↓
  claude_agent_sdk（不动，自动使用新端点）
```

对于非 Anthropic-native provider（OpenAI、Gemini、Ollama）：

```
OpenAIPlugin.normalize_transport()
  → 启动 LiteLLM 子进程（localhost:4000）
  → base_url = "http://localhost:4000"
  → api_key  = "sk-litellm"
       ↓
  os.environ["ANTHROPIC_BASE_URL"] = "http://localhost:4000"
  claude_agent_sdk → LiteLLM → OpenAI
```

---

## 4. 组件设计

### 4.1 `ProviderPlugin` Protocol

```python
class ProviderPlugin(Protocol):
    provider_name: str                    # "anthropic", "zhipu", ...
    api_type: Literal["anthropic-native", "openai-compatible"]

    def normalize_transport(self, model_id: str) -> TransportConfig:
        """返回 base_url 和 api_key"""
        ...

    def normalize_model_id(self, model_id: str) -> str:
        """处理模型 ID 别名，默认原样返回"""
        ...

    def requires_proxy(self) -> bool:
        """是否需要启动 LiteLLM 子进程"""
        ...
```

`TransportConfig` dataclass：
```python
@dataclass
class TransportConfig:
    base_url: str
    api_key: str
    model_id: str        # 最终传给 claude_agent_sdk 的模型 ID
```

### 4.2 内置 Plugin 实现

| Plugin | api_type | base_url | requires_proxy |
|--------|----------|----------|----------------|
| `AnthropicPlugin` | anthropic-native | `https://api.anthropic.com` | False |
| `ZhipuPlugin` | anthropic-native | `https://open.bigmodel.cn/api/anthropic` | False |
| `OpenAIPlugin` | openai-compatible | `http://localhost:4000` | True |
| `GeminiPlugin` | openai-compatible | `http://localhost:4000` | True |
| `OllamaPlugin` | openai-compatible | `http://localhost:4000` | True |

### 4.3 `ProviderRegistry`

```python
class ProviderRegistry:
    _plugins: dict[str, ProviderPlugin]

    def register(self, plugin: ProviderPlugin) -> None: ...
    def resolve(self, provider: str, model_id: str) -> TransportConfig: ...
    def initialize_from_env(self) -> None:
        # 解析 XFUSION_MODEL，调用对应 plugin，设置 ANTHROPIC_BASE_URL
        ...
```

### 4.4 LiteLLM 子进程管理

`LiteLLMProxyManager`：
- 检测是否已有进程占用 4000 端口，避免重复启动
- 按需生成 `litellm_config.yaml`（包含目标 provider 的 model mapping）
- 以 subprocess 启动，后端进程退出时自动清理

---

## 5. 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `backend/app/services/llm_router.py` | **新建** | Plugin 系统全部逻辑，~150 行 |
| `backend/app/core/config.py` | **修改** | 用 `model: str` 替换 `claude_model: str`，保留 `claude_enabled` |
| `backend/app/main.py` | **修改** | 启动时调用 `registry.initialize_from_env()` |
| `backend/.env.example` | **修改** | 更新示例配置 |
| `backend/pyproject.toml` | **修改** | 添加 `litellm` 依赖 |
| `backend/app/services/orchestrator.py` | **不动** | |
| `backend/app/services/platform.py` | **不动** | |
| 所有 frontend 文件 | **不动** | |

---

## 6. 错误处理

- `XFUSION_MODEL` 格式错误（缺少 `/`）→ 启动时 `ValueError`，明确报错信息
- provider 名未注册 → `ValueError: Unknown provider 'xxx'. Supported: anthropic, zhipu, openai, gemini, ollama`
- 对应 API Key 环境变量缺失 → `ValueError: ZhipuPlugin requires ZHIPU_API_KEY`
- LiteLLM 子进程启动失败 → 记录日志，后端继续启动但标记 `claude_enabled=False`

---

## 7. 各 Provider API Key 环境变量

| Provider | 必须设置的环境变量 |
|----------|-----------------|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `zhipu` | `ZHIPU_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `gemini` | `GEMINI_API_KEY` |
| `ollama` | 无（本地服务，无需 key） |

---

## 8. 不在本次范围内

- 前端模型切换 UI（后续可做）
- 运行时动态切换模型（需重启）
- 自定义 provider（用户自定义 base_url）
- 多 provider 并发（不同任务用不同模型）
