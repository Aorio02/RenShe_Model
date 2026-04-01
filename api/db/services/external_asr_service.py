import asyncio
import os
import re

import requests


class ExternalASRService:
    @staticmethod
    async def transcribe(
        audio_bytes: bytes,
        filename: str,
        mime_type: str | None = None,
    ) -> str:
        url = os.environ.get("EXTERNAL_ASR_URL", "").strip()
        if not url:
            raise RuntimeError("EXTERNAL_ASR_URL is not configured")

        timeout_ms = int(os.environ.get("EXTERNAL_ASR_TIMEOUT_MS", "30000"))
        auth_type = os.environ.get("EXTERNAL_ASR_AUTH_TYPE", "none").strip().lower()
        auth_value = os.environ.get("EXTERNAL_ASR_AUTH_VALUE", "").strip()

        headers = {}
        if auth_type == "bearer" and auth_value:
            headers["Authorization"] = f"Bearer {auth_value}"
        elif auth_type == "header" and auth_value:
            if ":" not in auth_value:
                raise RuntimeError("EXTERNAL_ASR_AUTH_VALUE must be 'Header-Name: value' when auth type is header")
            key, value = auth_value.split(":", 1)
            headers[key.strip()] = value.strip()

        def _request() -> requests.Response:
            return requests.post(
                url,
                headers=headers,
                files={"file": (filename, audio_bytes, mime_type or "application/octet-stream")},
                timeout=timeout_ms / 1000,
            )

        response = await asyncio.to_thread(_request)
        if response.status_code != 200:
            raise RuntimeError(f"external asr failed with status {response.status_code}")

        data = response.json()
        raw_text = data.get("text")
        if raw_text is None:
            raw_text = data.get("data", "")
        if isinstance(raw_text, dict):
            raw_text = raw_text.get("text", "")
        if not isinstance(raw_text, str):
            raw_text = str(raw_text or "")

        cleaned = re.sub(r"<\|.*?\|>", "", raw_text).strip()
        if not cleaned:
            raise RuntimeError("external asr returned empty text")
        return cleaned
