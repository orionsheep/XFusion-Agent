from __future__ import annotations

from dataclasses import dataclass

import httpx


SILICONFLOW_TRANSCRIPTION_URL = "https://api.siliconflow.cn/v1/audio/transcriptions"


@dataclass
class TranscriptionResult:
    text: str
    model: str


class VoiceTranscriptionError(RuntimeError):
    pass


async def transcribe_with_siliconflow(
    *,
    api_key: str,
    audio_bytes: bytes,
    filename: str,
    content_type: str,
    model: str,
    timeout_seconds: int = 90,
) -> TranscriptionResult:
    if not api_key.strip():
        raise VoiceTranscriptionError("SiliconFlow API Key 未配置")
    if not audio_bytes:
        raise VoiceTranscriptionError("音频内容为空")

    files = {
        "file": (filename or "voice.webm", audio_bytes, content_type or "audio/webm"),
        "model": (None, model),
    }
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=timeout_seconds) as client:
        response = await client.post(SILICONFLOW_TRANSCRIPTION_URL, headers=headers, files=files)
    if response.status_code >= 400:
        detail = response.text[:500]
        raise VoiceTranscriptionError(f"SiliconFlow 语音转写失败: HTTP {response.status_code} {detail}")
    payload = response.json()
    text = str(payload.get("text") or "").strip()
    if not text:
        raise VoiceTranscriptionError("SiliconFlow 未返回转写文本")
    return TranscriptionResult(text=text, model=model)
