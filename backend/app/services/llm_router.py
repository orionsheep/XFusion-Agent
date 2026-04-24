from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable, Protocol, runtime_checkable

import httpx


# ---------------------------------------------------------------------------
# Base types
# ---------------------------------------------------------------------------

@dataclass
class LLMMessage:
    role: str    # "system" | "user" | "assistant"
    content: str


@dataclass
class LLMResponse:
    text: str
    provider: str
    model_id: str


@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any]   # JSON Schema object


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass
class AgentLoopResult:
    final_text: str
    turns: int
    tool_calls_made: list[ToolCall] = field(default_factory=list)


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
    ) -> LLMResponse: ...

    def normalize_model_id(self, model_id: str) -> str: ...

    def is_available(self) -> bool: ...


# ---------------------------------------------------------------------------
# OpenAI-compatible base plugin
# Most providers speak OpenAI /v1/chat/completions format.
# Subclass this and set provider_name, _BASE_URL, _API_KEY_ENV.
# ---------------------------------------------------------------------------

class OpenAICompatiblePlugin:
    provider_name: str = ""
    _BASE_URL: str = ""
    _API_KEY_ENV: str = ""
    _ALIASES: dict[str, str] = {}
    _SUPPORTS_CUSTOM_MODEL_INPUT: bool = True

    def normalize_model_id(self, model_id: str) -> str:
        return self._ALIASES.get(model_id, model_id)

    def is_available(self) -> bool:
        return bool(os.getenv(self._API_KEY_ENV)) if self._API_KEY_ENV else True

    def _get_api_key(self) -> str:
        return os.environ[self._API_KEY_ENV]

    def _auth_header(self, api_key: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {api_key}"}

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

        body: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
        }

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                self._BASE_URL,
                headers={**self._auth_header(api_key), "content-type": "application/json"},
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            return LLMResponse(text=text, provider=self.provider_name, model_id=model)

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
        all_tool_calls: list[ToolCall] = []

        # OpenAI tool format
        tools_payload = [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            }
            for t in tools
        ]

        # Build mutable message history (OpenAI dict format)
        history: list[dict[str, Any]] = [
            {"role": m.role, "content": m.content} for m in messages
        ]

        for turn in range(max_turns):
            body: dict[str, Any] = {
                "model": model,
                "max_tokens": max_tokens,
                "messages": history,
                "tools": tools_payload,
                "tool_choice": "auto",
            }

            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    self._BASE_URL,
                    headers={**self._auth_header(api_key), "content-type": "application/json"},
                    json=body,
                )
                resp.raise_for_status()
                data = resp.json()

            choice = data["choices"][0]
            finish_reason = choice.get("finish_reason")
            assistant_msg = choice["message"]

            # Add assistant message to history
            history.append(assistant_msg)

            if finish_reason != "tool_calls" or not assistant_msg.get("tool_calls"):
                # Model is done
                return AgentLoopResult(
                    final_text=assistant_msg.get("content") or "",
                    turns=turn + 1,
                    tool_calls_made=all_tool_calls,
                )

            # Execute each tool call
            for tc in assistant_msg["tool_calls"]:
                args_str = tc["function"].get("arguments") or "{}"
                call = ToolCall(
                    id=tc["id"],
                    name=tc["function"]["name"],
                    arguments=json.loads(args_str),
                )
                all_tool_calls.append(call)
                result = await tool_executor(call.name, call.arguments)
                history.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": result,
                })

        # Hit max_turns — ask model to summarize
        history.append({"role": "user", "content": "Please summarize what was accomplished."})
        body = {"model": model, "max_tokens": max_tokens, "messages": history}
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                self._BASE_URL,
                headers={**self._auth_header(api_key), "content-type": "application/json"},
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
        return AgentLoopResult(
            final_text=data["choices"][0]["message"].get("content") or "",
            turns=max_turns,
            tool_calls_made=all_tool_calls,
        )


# ---------------------------------------------------------------------------
# Anthropic-native base plugin
# Providers that expose the Anthropic /v1/messages format.
# ---------------------------------------------------------------------------

class AnthropicNativePlugin:
    provider_name: str = ""
    _BASE_URL: str = ""
    _API_KEY_ENV: str = ""
    _VERSION: str = "2023-06-01"
    _ALIASES: dict[str, str] = {}

    def normalize_model_id(self, model_id: str) -> str:
        return self._ALIASES.get(model_id, model_id)

    def is_available(self) -> bool:
        return bool(os.getenv(self._API_KEY_ENV))

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

        system = next((m.content for m in messages if m.role == "system"), "")
        user_messages = [
            {"role": m.role, "content": m.content}
            for m in messages if m.role != "system"
        ]
        body: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": user_messages}
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
            return LLMResponse(text=text, provider=self.provider_name, model_id=model)

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
        all_tool_calls: list[ToolCall] = []

        # Anthropic tool format
        tools_payload = [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": t.parameters,
            }
            for t in tools
        ]

        system = next((m.content for m in messages if m.role == "system"), "")
        history: list[dict[str, Any]] = [
            {"role": m.role, "content": m.content}
            for m in messages if m.role != "system"
        ]

        headers = {
            "x-api-key": api_key,
            "anthropic-version": self._VERSION,
            "content-type": "application/json",
        }

        for turn in range(max_turns):
            body: dict[str, Any] = {
                "model": model,
                "max_tokens": max_tokens,
                "messages": history,
                "tools": tools_payload,
            }
            if system:
                body["system"] = system

            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(self._BASE_URL, headers=headers, json=body)
                resp.raise_for_status()
                data = resp.json()

            stop_reason = data.get("stop_reason")
            content_blocks = data.get("content", [])

            # Add assistant turn to history
            history.append({"role": "assistant", "content": content_blocks})

            if stop_reason != "tool_use":
                text = " ".join(
                    b.get("text", "") for b in content_blocks if b.get("type") == "text"
                )
                return AgentLoopResult(
                    final_text=text,
                    turns=turn + 1,
                    tool_calls_made=all_tool_calls,
                )

            # Execute tool_use blocks
            tool_results: list[dict[str, Any]] = []
            for block in content_blocks:
                if block.get("type") != "tool_use":
                    continue
                call = ToolCall(
                    id=block["id"],
                    name=block["name"],
                    arguments=block.get("input", {}),
                )
                all_tool_calls.append(call)
                result = await tool_executor(call.name, call.arguments)
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": call.id,
                    "content": result,
                })

            history.append({"role": "user", "content": tool_results})

        # Hit max_turns
        body = {"model": model, "max_tokens": max_tokens, "messages": history}
        if system:
            body["system"] = system
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(self._BASE_URL, headers=headers, json=body)
            resp.raise_for_status()
            data = resp.json()
        text = " ".join(
            b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
        )
        return AgentLoopResult(final_text=text, turns=max_turns, tool_calls_made=all_tool_calls)


# ===========================================================================
# Anthropic-native providers
# ===========================================================================

class AnthropicPlugin(AnthropicNativePlugin):
    provider_name = "anthropic"
    _BASE_URL = "https://api.anthropic.com/v1/messages"
    _API_KEY_ENV = "ANTHROPIC_API_KEY"
    _ALIASES = {
        "opus":   "claude-opus-4-7",
        "sonnet": "claude-sonnet-4-6",
        "haiku":  "claude-haiku-4-5-20251001",
    }


class ZhipuPlugin(AnthropicNativePlugin):
    """智谱 GLM — Anthropic 兼容端点"""
    provider_name = "zhipu"
    _BASE_URL = "https://open.bigmodel.cn/api/anthropic/v1/messages"
    _API_KEY_ENV = "ZHIPU_API_KEY"
    _ALIASES = {
        "glm4":      "glm-4.7",
        "glm4air":   "glm-4.5-air",
        "glm4flash": "glm-4.5-flash",
    }


# ===========================================================================
# OpenAI-compatible providers
# ===========================================================================

class OpenAIPlugin(OpenAICompatiblePlugin):
    provider_name = "openai"
    _BASE_URL = "https://api.openai.com/v1/chat/completions"
    _API_KEY_ENV = "OPENAI_API_KEY"


class DeepSeekPlugin(OpenAICompatiblePlugin):
    """DeepSeek — 国内领先推理模型"""
    provider_name = "deepseek"
    _BASE_URL = "https://api.deepseek.com/v1/chat/completions"
    _API_KEY_ENV = "DEEPSEEK_API_KEY"
    _ALIASES = {"v3": "deepseek-chat", "r1": "deepseek-reasoner"}


class MoonshotPlugin(OpenAICompatiblePlugin):
    """Moonshot / Kimi — 月之暗面"""
    provider_name = "moonshot"
    _BASE_URL = "https://api.moonshot.cn/v1/chat/completions"
    _API_KEY_ENV = "MOONSHOT_API_KEY"
    _ALIASES = {"kimi": "moonshot-v1-8k"}


class QwenPlugin(OpenAICompatiblePlugin):
    """通义千问 — 阿里云 DashScope"""
    provider_name = "qwen"
    _BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
    _API_KEY_ENV = "DASHSCOPE_API_KEY"
    _ALIASES = {"max": "qwen-max", "plus": "qwen-plus", "turbo": "qwen-turbo"}


class DoubaoPlugin(OpenAICompatiblePlugin):
    """豆包 — 字节跳动火山引擎"""
    provider_name = "doubao"
    _BASE_URL = "https://ark.cn-beijing.volces.com/api/v3/chat/completions"
    _API_KEY_ENV = "DOUBAO_API_KEY"


class SiliconFlowPlugin(OpenAICompatiblePlugin):
    """硅基流动 — 国内 OpenAI 兼容聚合"""
    provider_name = "siliconflow"
    _BASE_URL = "https://api.siliconflow.cn/v1/chat/completions"
    _API_KEY_ENV = "SILICONFLOW_API_KEY"


class YiPlugin(OpenAICompatiblePlugin):
    """零一万物 Yi"""
    provider_name = "yi"
    _BASE_URL = "https://api.lingyiwanwu.com/v1/chat/completions"
    _API_KEY_ENV = "YI_API_KEY"
    _ALIASES = {"large": "yi-large", "medium": "yi-medium"}


class MistralPlugin(OpenAICompatiblePlugin):
    """Mistral AI"""
    provider_name = "mistral"
    _BASE_URL = "https://api.mistral.ai/v1/chat/completions"
    _API_KEY_ENV = "MISTRAL_API_KEY"
    _ALIASES = {"large": "mistral-large-latest", "small": "mistral-small-latest"}


class GroqPlugin(OpenAICompatiblePlugin):
    """Groq — 超快推理"""
    provider_name = "groq"
    _BASE_URL = "https://api.groq.com/openai/v1/chat/completions"
    _API_KEY_ENV = "GROQ_API_KEY"
    _ALIASES = {"llama3": "llama3-70b-8192", "mixtral": "mixtral-8x7b-32768"}


class TogetherPlugin(OpenAICompatiblePlugin):
    """Together AI — 开源模型托管"""
    provider_name = "together"
    _BASE_URL = "https://api.together.xyz/v1/chat/completions"
    _API_KEY_ENV = "TOGETHER_API_KEY"


class OpenRouterPlugin(OpenAICompatiblePlugin):
    """OpenRouter — 统一多模型网关"""
    provider_name = "openrouter"
    _BASE_URL = "https://openrouter.ai/api/v1/chat/completions"
    _API_KEY_ENV = "OPENROUTER_API_KEY"

    def _auth_header(self, api_key: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {api_key}",
            "HTTP-Referer": "https://xfusion-agent.local",
        }


class PerplexityPlugin(OpenAICompatiblePlugin):
    """Perplexity — 联网推理（不支持 tool_calls）"""
    provider_name = "perplexity"
    _BASE_URL = "https://api.perplexity.ai/chat/completions"
    _API_KEY_ENV = "PERPLEXITY_API_KEY"
    _ALIASES = {"sonar": "sonar-pro"}

    async def run_agent_loop(self, **_: Any) -> AgentLoopResult:
        raise NotImplementedError("Perplexity Sonar does not support OpenAI tool_calls protocol")


class CoherePlugin(OpenAICompatiblePlugin):
    """Cohere Command（不支持 tool_calls via compatibility endpoint）"""
    provider_name = "cohere"
    _BASE_URL = "https://api.cohere.ai/compatibility/v1/chat/completions"
    _API_KEY_ENV = "COHERE_API_KEY"
    _ALIASES = {"command": "command-r-plus"}

    async def run_agent_loop(self, **_: Any) -> AgentLoopResult:
        raise NotImplementedError("Cohere compatibility endpoint does not support OpenAI tool_calls protocol")


# ===========================================================================
# Special providers
# ===========================================================================

class OllamaPlugin(OpenAICompatiblePlugin):
    """Ollama — 本地模型，无需 API Key"""
    provider_name = "ollama"
    _API_KEY_ENV = ""

    def __init__(self) -> None:
        self._BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434") + "/v1/chat/completions"

    def _get_api_key(self) -> str:
        return "ollama"  # Ollama 接受任意字符串


class WenxinPlugin:
    """百度文心一言 — OAuth access_token 格式"""
    provider_name = "wenxin"
    _TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token"
    _CHAT_URL = "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/{model}"
    _ALIASES: dict[str, str] = {
        "4":      "completions_pro",
        "turbo":  "eb-instant",
        "speed":  "ernie_speed",
    }

    def normalize_model_id(self, model_id: str) -> str:
        return self._ALIASES.get(model_id, model_id)

    def is_available(self) -> bool:
        return bool(os.getenv("WENXIN_API_KEY") and os.getenv("WENXIN_SECRET_KEY"))

    async def _get_access_token(self, client: httpx.AsyncClient) -> str:
        resp = await client.post(
            self._TOKEN_URL,
            params={
                "grant_type": "client_credentials",
                "client_id": os.environ["WENXIN_API_KEY"],
                "client_secret": os.environ["WENXIN_SECRET_KEY"],
            },
        )
        resp.raise_for_status()
        return resp.json()["access_token"]

    async def chat_completion(
        self,
        *,
        model_id: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 30,
        api_key_override: str | None = None,
    ) -> LLMResponse:
        model = self.normalize_model_id(model_id)
        url = self._CHAT_URL.format(model=model)

        system = next((m.content for m in messages if m.role == "system"), "")
        chat_messages = [
            {"role": m.role, "content": m.content}
            for m in messages if m.role != "system"
        ]
        body: dict[str, Any] = {"messages": chat_messages}
        if system:
            body["system"] = system

        async with httpx.AsyncClient(timeout=timeout) as client:
            token = await self._get_access_token(client)
            resp = await client.post(
                url,
                params={"access_token": token},
                headers={"content-type": "application/json"},
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["result"]
            return LLMResponse(text=text, provider="wenxin", model_id=model)


class MinimaxPlugin(OpenAICompatiblePlugin):
    """MiniMax — 海螺 AI"""
    provider_name = "minimax"
    _BASE_URL = "https://api.minimax.chat/v1/text/chatcompletion_v2"
    _API_KEY_ENV = "MINIMAX_API_KEY"
    _ALIASES = {"abab6": "abab6.5s-chat", "abab5": "abab5.5-chat"}


class BaichuanPlugin(OpenAICompatiblePlugin):
    """百川智能"""
    provider_name = "baichuan"
    _BASE_URL = "https://api.baichuan-ai.com/v1/chat/completions"
    _API_KEY_ENV = "BAICHUAN_API_KEY"
    _ALIASES = {"turbo": "Baichuan4-Turbo", "air": "Baichuan4-Air"}


class HunyuanPlugin(OpenAICompatiblePlugin):
    """腾讯混元"""
    provider_name = "hunyuan"
    _BASE_URL = "https://api.hunyuan.cloud.tencent.com/v1/chat/completions"
    _API_KEY_ENV = "HUNYUAN_API_KEY"
    _ALIASES = {"pro": "hunyuan-pro", "lite": "hunyuan-lite"}


class SparkPlugin:
    """讯飞星火 — 原生 WebSocket/HTTP 格式"""
    provider_name = "spark"
    _BASE_URL = "https://spark-api-open.xf-yun.com/v1/chat/completions"
    _API_KEY_ENV = "SPARK_API_KEY"
    _ALIASES: dict[str, str] = {"max": "generalv3.5", "pro": "generalv3", "lite": "general"}

    def normalize_model_id(self, model_id: str) -> str:
        return self._ALIASES.get(model_id, model_id)

    def is_available(self) -> bool:
        return bool(os.getenv("SPARK_API_KEY"))

    async def chat_completion(
        self,
        *,
        model_id: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 30,
        api_key_override: str | None = None,
    ) -> LLMResponse:
        api_key = api_key_override or os.environ["SPARK_API_KEY"]
        model = self.normalize_model_id(model_id)
        body: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
        }
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                self._BASE_URL,
                headers={"Authorization": f"Bearer {api_key}", "content-type": "application/json"},
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            return LLMResponse(text=text, provider="spark", model_id=model)


class GeminiPlugin:
    """Google Gemini — 原生 API 格式"""
    provider_name = "gemini"
    _BASE = "https://generativelanguage.googleapis.com/v1beta/models"
    _ALIASES: dict[str, str] = {
        "flash": "gemini-2.0-flash",
        "pro":   "gemini-2.0-pro",
        "flash-lite": "gemini-2.0-flash-lite",
    }

    def normalize_model_id(self, model_id: str) -> str:
        return self._ALIASES.get(model_id, model_id)

    def is_available(self) -> bool:
        return bool(os.getenv("GEMINI_API_KEY"))

    async def chat_completion(
        self,
        *,
        model_id: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 30,
        api_key_override: str | None = None,
    ) -> LLMResponse:
        api_key = api_key_override or os.environ["GEMINI_API_KEY"]
        model = self.normalize_model_id(model_id)
        url = f"{self._BASE}/{model}:generateContent?key={api_key}"

        system = next((m.content for m in messages if m.role == "system"), "")
        contents = [
            {"role": "user" if m.role == "user" else "model", "parts": [{"text": m.content}]}
            for m in messages if m.role != "system"
        ]
        body: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"maxOutputTokens": max_tokens},
        }
        if system:
            body["system_instruction"] = {"parts": [{"text": system}]}

        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, headers={"content-type": "application/json"}, json=body)
            resp.raise_for_status()
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return LLMResponse(text=text, provider="gemini", model_id=model)

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
        api_key = api_key_override or os.environ["GEMINI_API_KEY"]
        model = self.normalize_model_id(model_id)
        all_tool_calls: list[ToolCall] = []

        tools_payload = [{
            "function_declarations": [
                {"name": t.name, "description": t.description, "parameters": t.parameters}
                for t in tools
            ]
        }]

        system = next((m.content for m in messages if m.role == "system"), "")
        contents: list[dict[str, Any]] = [
            {"role": "user" if m.role == "user" else "model",
             "parts": [{"text": m.content}]}
            for m in messages if m.role != "system"
        ]

        url_base = f"{self._BASE}/{model}"

        for turn in range(max_turns):
            body: dict[str, Any] = {
                "contents": contents,
                "tools": tools_payload,
                "generationConfig": {"maxOutputTokens": max_tokens},
            }
            if system:
                body["system_instruction"] = {"parts": [{"text": system}]}

            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    f"{url_base}:generateContent?key={api_key}",
                    headers={"content-type": "application/json"},
                    json=body,
                )
                resp.raise_for_status()
                data = resp.json()

            candidate = data["candidates"][0]
            parts = candidate["content"]["parts"]
            finish_reason = candidate.get("finishReason", "")

            # Add model turn to history
            contents.append({"role": "model", "parts": parts})

            func_calls = [p for p in parts if "functionCall" in p]
            if not func_calls:
                text = " ".join(p.get("text", "") for p in parts if "text" in p)
                return AgentLoopResult(
                    final_text=text,
                    turns=turn + 1,
                    tool_calls_made=all_tool_calls,
                )

            # Execute function calls
            responses: list[dict[str, Any]] = []
            for i, part in enumerate(func_calls):
                fc = part["functionCall"]
                call = ToolCall(
                    id=f"{fc['name']}_{turn}_{i}",
                    name=fc["name"],
                    arguments=fc.get("args", {}),
                )
                all_tool_calls.append(call)
                result = await tool_executor(call.name, call.arguments)
                responses.append({
                    "functionResponse": {
                        "name": fc["name"],
                        "response": {"output": result},
                    }
                })

            contents.append({"role": "user", "parts": responses})

        # Hit max_turns
        body = {"contents": contents, "generationConfig": {"maxOutputTokens": max_tokens}}
        if system:
            body["system_instruction"] = {"parts": [{"text": system}]}
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{url_base}:generateContent?key={api_key}",
                headers={"content-type": "application/json"},
                json=body,
            )
            resp.raise_for_status()
            data = resp.json()
        parts = data["candidates"][0]["content"]["parts"]
        text = " ".join(p.get("text", "") for p in parts if "text" in p)
        return AgentLoopResult(final_text=text, turns=max_turns, tool_calls_made=all_tool_calls)


# ===========================================================================
# ProviderRegistry
# ===========================================================================

class ProviderRegistry:
    def __init__(self) -> None:
        self._plugins: dict[str, Any] = {}
        for plugin in [
            # Anthropic-native
            AnthropicPlugin(),
            ZhipuPlugin(),
            # OpenAI-compatible — 国际
            OpenAIPlugin(),
            MistralPlugin(),
            GroqPlugin(),
            TogetherPlugin(),
            OpenRouterPlugin(),
            PerplexityPlugin(),
            CoherePlugin(),
            # OpenAI-compatible — 国内
            DeepSeekPlugin(),
            MoonshotPlugin(),
            QwenPlugin(),
            DoubaoPlugin(),
            SiliconFlowPlugin(),
            YiPlugin(),
            MinimaxPlugin(),
            BaichuanPlugin(),
            HunyuanPlugin(),
            # 原生格式
            WenxinPlugin(),
            SparkPlugin(),
            GeminiPlugin(),
            # 本地
            OllamaPlugin(),
        ]:
            self._plugins[plugin.provider_name] = plugin

    def register(self, plugin: Any) -> None:
        """注册自定义 provider plugin"""
        self._plugins[plugin.provider_name] = plugin

    def resolve(self, provider: str) -> Any:
        plugin = self._plugins.get(provider)
        if plugin is None:
            supported = ", ".join(sorted(self._plugins))
            raise ValueError(f"Unknown provider '{provider}'. Supported: {supported}")
        return plugin

    def list_providers(self) -> list[str]:
        return sorted(self._plugins)

    def list_provider_info(self) -> list[dict]:
        result = []
        for name, plugin in sorted(self._plugins.items()):
            aliases = getattr(plugin, "_ALIASES", {})
            models = [f"{name}/{v}" for v in aliases.values()] if aliases else []
            result.append({
                "provider_name": name,
                "models": models,
                "env_key": getattr(plugin, "_API_KEY_ENV", ""),
                "env_available": bool(plugin.is_available()),
                "supports_custom_model": bool(
                    getattr(plugin, "_SUPPORTS_CUSTOM_MODEL_INPUT", False)
                ),
            })
        return result

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
        """
        通用 Agent Loop：支持任意 provider / 任意 Function Calling 格式。

        model:         "provider/model-id"
        tools:         工具定义列表
        tool_executor: async (tool_name, arguments) -> result_str
                       调用方负责实际执行（SSH、本地命令等）
        """
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

    async def chat_completion(
        self,
        *,
        model: str,
        messages: list[LLMMessage],
        max_tokens: int = 4096,
        timeout: int = 30,
        api_keys: dict[str, str] | None = None,
    ) -> str:
        """
        model 格式: "provider/model-id"
        示例: "zhipu/glm-4.7" | "deepseek/v3" | "openrouter/anthropic/claude-opus-4"
        """
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


# 全局单例
registry = ProviderRegistry()
