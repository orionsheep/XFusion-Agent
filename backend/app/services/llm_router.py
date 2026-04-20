from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable

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
# AnthropicPlugin
# ---------------------------------------------------------------------------

class AnthropicPlugin:
    provider_name = "anthropic"
    _BASE_URL = "https://api.anthropic.com/v1/messages"
    _VERSION = "2023-06-01"

    _ALIASES: dict[str, str] = {
        "opus":   "claude-opus-4-7",
        "sonnet": "claude-sonnet-4-6",
        "haiku":  "claude-haiku-4-5-20251001",
    }

    def normalize_model_id(self, model_id: str) -> str:
        return self._ALIASES.get(model_id, model_id)

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


# ---------------------------------------------------------------------------
# ZhipuPlugin  (Anthropic-compatible endpoint)
# ---------------------------------------------------------------------------

class ZhipuPlugin:
    provider_name = "zhipu"
    _BASE_URL = "https://open.bigmodel.cn/api/anthropic/v1/messages"
    _VERSION = "2023-06-01"

    _ALIASES: dict[str, str] = {
        "glm4":      "glm-4.7",
        "glm4air":   "glm-4.5-air",
        "glm4flash": "glm-4.5-flash",
    }

    def normalize_model_id(self, model_id: str) -> str:
        return self._ALIASES.get(model_id, model_id)

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


# ---------------------------------------------------------------------------
# OpenAIPlugin
# ---------------------------------------------------------------------------

class OpenAIPlugin:
    provider_name = "openai"
    _BASE_URL = "https://api.openai.com/v1/chat/completions"

    def normalize_model_id(self, model_id: str) -> str:
        return model_id

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

        body: dict[str, Any] = {
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


# ---------------------------------------------------------------------------
# OllamaPlugin
# ---------------------------------------------------------------------------

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
        body: dict[str, Any] = {
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


# ---------------------------------------------------------------------------
# GeminiPlugin
# ---------------------------------------------------------------------------

class GeminiPlugin:
    provider_name = "gemini"
    _BASE = "https://generativelanguage.googleapis.com/v1beta/models"

    _ALIASES: dict[str, str] = {
        "flash": "gemini-2.0-flash",
        "pro":   "gemini-2.0-pro",
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
    ) -> LLMResponse:
        api_key = os.environ["GEMINI_API_KEY"]
        model = self.normalize_model_id(model_id)
        url = f"{self._BASE}/{model}:generateContent?key={api_key}"

        system = next((m.content for m in messages if m.role == "system"), "")
        contents = [
            {
                "role": "user" if m.role == "user" else "model",
                "parts": [{"text": m.content}],
            }
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


# ---------------------------------------------------------------------------
# ProviderRegistry
# ---------------------------------------------------------------------------

class ProviderRegistry:
    def __init__(self) -> None:
        self._plugins: dict[str, Any] = {}
        for plugin in [
            AnthropicPlugin(),
            ZhipuPlugin(),
            OpenAIPlugin(),
            GeminiPlugin(),
            OllamaPlugin(),
        ]:
            self._plugins[plugin.provider_name] = plugin

    def register(self, plugin: Any) -> None:
        self._plugins[plugin.provider_name] = plugin

    def resolve(self, provider: str) -> Any:
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
                f"XFUSION_MODEL must be 'provider/model-id' format, got: '{model}'"
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
