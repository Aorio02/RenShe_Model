import asyncio
import copy
import logging
import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from typing import Any, AsyncGenerator
from uuid import uuid4

from api.db.services.conversation_service import ConversationService
from api.db.services.dialog_service import DialogService, async_chat, clean_tts_text
from api.db.services.external_asr_service import ExternalASRService
from api.db.services.voice_storage_service import VoiceStorageService
from api.db.services.llm_service import LLMBundle
from common.constants import LLMType
from common.misc_utils import get_uuid


DEFAULT_TTS_MIME_TYPE = "audio/mpeg"
PSEUDO_STREAM_UNIT = (os.getenv("RAGFLOW_PSEUDO_STREAM_UNIT") or "char").strip().lower()
PSEUDO_STREAM_MAX_CHARS = max(int(os.getenv("RAGFLOW_PSEUDO_STREAM_MAX_CHARS", "14")), 6)
PSEUDO_STREAM_MIN_CHARS = max(
    4,
    min(int(os.getenv("RAGFLOW_PSEUDO_STREAM_MIN_CHARS", "5")), PSEUDO_STREAM_MAX_CHARS),
)
PSEUDO_STREAM_BREAK_CHARS = "。！？；，、,.!?;\n"
PSEUDO_STREAM_CHARS_PER_SECOND = max(
    float(os.getenv("RAGFLOW_PSEUDO_STREAM_CHARS_PER_SECOND", "18.0")),
    1.0,
)
PSEUDO_STREAM_MIN_DELAY_SECONDS = max(
    float(os.getenv("RAGFLOW_PSEUDO_STREAM_MIN_DELAY_SECONDS", "0.035")),
    0.0,
)
PSEUDO_STREAM_MAX_DELAY_SECONDS = max(
    float(os.getenv("RAGFLOW_PSEUDO_STREAM_MAX_DELAY_SECONDS", "0.25")),
    PSEUDO_STREAM_MIN_DELAY_SECONDS,
)
PSEUDO_STREAM_PUNCTUATION_PAUSE_SECONDS = max(
    float(os.getenv("RAGFLOW_PSEUDO_STREAM_PUNCTUATION_PAUSE_SECONDS", "0.06")),
    0.0,
)


def _now_ts() -> float:
    return time.time()


def _stream_event(event_type: str, data: Any, code: int = 0) -> dict[str, Any]:
    return {"code": code, "type": event_type, "data": data}


def _clone_message(message: dict[str, Any]) -> dict[str, Any]:
    return copy.deepcopy(message)


def _persist_conversation(conv) -> None:
    ConversationService.update_by_id(
        conv.id,
        {
            "message": conv.message,
            "reference": conv.reference,
        },
    )


def _base_voice_message(
    message_id: str,
    role: str,
    input_mode: str = "voice",
) -> dict[str, Any]:
    return {
        "id": message_id,
        "role": role,
        "content": "",
        "input_mode": input_mode,
        "created_at": _now_ts(),
    }


def _build_user_voice_message(
    message_id: str,
    file_id: str,
    mime_type: str,
    duration_ms: int,
    waveform: list[int] | None,
) -> dict[str, Any]:
    message = _base_voice_message(message_id, "user")
    message["voice"] = {
        "kind": "single",
        "status": "transcribing",
        "file_id": file_id,
        "mime_type": mime_type,
        "duration_ms": duration_ms,
        "waveform": waveform or [],
    }
    return message


def _build_assistant_voice_message(message_id: str, mime_type: str = DEFAULT_TTS_MIME_TYPE) -> dict[str, Any]:
    message = _base_voice_message(message_id, "assistant")
    message["voice"] = {
        "kind": "single",
        "status": "streaming",
        "mime_type": mime_type,
    }
    return message


def _conversation_messages_for_chat(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    msg = []
    for item in messages:
        if item.get("role") == "system":
            continue
        if not (item.get("content") or "").strip() and not item.get("doc_ids") and not item.get("files"):
            continue
        if item.get("role") == "assistant" and not msg:
            continue
        msg.append(item)
    return msg


def _message_index(conv, message_id: str) -> int:
    for idx, message in enumerate(conv.message or []):
        if message.get("id") == message_id:
            return idx
    return -1


def _message_index_by_id_and_role(conv, message_id: str, role: str | None = None) -> int:
    for idx, message in enumerate(conv.message or []):
        if message.get("id") != message_id:
            continue
        if role and message.get("role") != role:
            continue
        return idx
    return -1


def _voice_message_index(
    conv,
    message_id: str,
    seq: int | None = None,
    role: str | None = None,
) -> int:
    candidates = [
        (idx, message)
        for idx, message in enumerate(conv.message or [])
        if message.get("id") == message_id
        and (role is None or message.get("role") == role)
    ]
    if not candidates:
        return -1

    if seq is not None:
        for idx, message in reversed(candidates):
            segments = (message.get("voice") or {}).get("segments") or []
            if any(int(item.get("seq", -1)) == int(seq) for item in segments):
                return idx

    for idx, message in reversed(candidates):
        voice = message.get("voice") or {}
        if voice.get("kind") == "single" and voice.get("file_id"):
            return idx

    for idx, message in reversed(candidates):
        voice = message.get("voice") or {}
        if voice.get("segments") or voice.get("file_id"):
            return idx

    return candidates[-1][0]


def _normalize_audio_mime_type(mime_type: str | None, default: str = DEFAULT_TTS_MIME_TYPE) -> str:
    if not mime_type:
        return default
    return mime_type.split(";", 1)[0].strip().lower() or default


def split_answer_for_pseudo_stream(text: str, max_chars: int = PSEUDO_STREAM_MAX_CHARS) -> list[str]:
    if not text:
        return []

    if PSEUDO_STREAM_UNIT == "char":
        return list(text)

    chunks: list[str] = []
    start = 0
    total = len(text)
    max_chars = max(int(max_chars or PSEUDO_STREAM_MAX_CHARS), 8)
    min_chars = max(6, min(PSEUDO_STREAM_MIN_CHARS, max_chars))

    while start < total:
        remaining = total - start
        if remaining <= max_chars:
            chunks.append(text[start:])
            break

        limit = min(total, start + max_chars)
        scan_start = min(total, start + min_chars)
        split_at = -1

        for idx in range(limit, scan_start, -1):
            if text[idx - 1] in PSEUDO_STREAM_BREAK_CHARS:
                split_at = idx
                break

        if split_at < 0:
            for idx in range(limit, scan_start, -1):
                if text[idx - 1].isspace():
                    split_at = idx
                    break

        if split_at < 0:
            split_at = limit

        chunks.append(text[start:split_at])
        start = split_at

    return [chunk for chunk in chunks if chunk]


def pseudo_stream_delay_for_chunk(text: str) -> float:
    effective_chars = sum(1 for char in (text or "") if not char.isspace())
    if effective_chars <= 0:
        return PSEUDO_STREAM_MIN_DELAY_SECONDS

    delay = effective_chars / PSEUDO_STREAM_CHARS_PER_SECOND
    tail = (text or "").rstrip()
    if tail and tail[-1] in "。！？；.!?;":
        delay += PSEUDO_STREAM_PUNCTUATION_PAUSE_SECONDS

    return max(
        PSEUDO_STREAM_MIN_DELAY_SECONDS,
        min(delay, PSEUDO_STREAM_MAX_DELAY_SECONDS),
    )


def _build_single_voice_state(
    previous_voice: dict[str, Any] | None,
    *,
    status: str,
    mime_type: str | None = None,
    file_id: str | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    voice = copy.deepcopy(previous_voice or {})
    voice["kind"] = "single"
    voice["status"] = status
    voice["mime_type"] = _normalize_audio_mime_type(
        mime_type or voice.get("mime_type"),
        default=DEFAULT_TTS_MIME_TYPE,
    )
    voice.pop("segments", None)

    if file_id:
        voice["file_id"] = file_id
    else:
        voice.pop("file_id", None)

    if error:
        voice["error"] = error
    else:
        voice.pop("error", None)

    return voice


class VoiceChatService:
    _assistant_tts_executor = ThreadPoolExecutor(
        max_workers=2,
        thread_name_prefix="assistant-tts",
    )
    _assistant_tts_tasks: dict[str, Future] = {}
    _assistant_tts_tasks_lock = threading.Lock()

    @staticmethod
    def _assistant_tts_task_key(conversation_id: str, message_id: str) -> str:
        return f"{conversation_id}:{message_id}"

    @classmethod
    def _get_assistant_tts_task(cls, conversation_id: str, message_id: str) -> Future | None:
        task_key = cls._assistant_tts_task_key(conversation_id, message_id)
        with cls._assistant_tts_tasks_lock:
            return cls._assistant_tts_tasks.get(task_key)

    @classmethod
    def _set_assistant_voice(
        cls,
        conv,
        idx: int,
        *,
        status: str,
        mime_type: str | None = None,
        file_id: str | None = None,
        error: str | None = None,
    ) -> None:
        message = conv.message[idx]
        message["voice"] = _build_single_voice_state(
            message.get("voice"),
            status=status,
            mime_type=mime_type,
            file_id=file_id,
            error=error,
        )
        message["created_at"] = _now_ts()
        conv.message[idx] = message

    @classmethod
    def prepare_assistant_tts_message(
        cls,
        conv,
        message_id: str,
        text: str | None = None,
    ) -> str:
        idx = _message_index_by_id_and_role(conv, message_id, "assistant")
        if idx < 0:
            raise LookupError("Assistant message not found!")

        cleaned_text = clean_tts_text(
            text if text is not None else (conv.message[idx].get("content") or "")
        )
        if cleaned_text:
            cls._set_assistant_voice(
                conv,
                idx,
                status="streaming",
            )
            return cleaned_text

        cls._set_assistant_voice(
            conv,
            idx,
            status="failed",
            error="no_readable_content",
        )
        return ""

    @classmethod
    def enqueue_assistant_tts_task(
        cls,
        *,
        user_id: str,
        conversation_id: str,
        message_id: str,
    ) -> bool:
        if not conversation_id or not message_id:
            return False

        task_key = cls._assistant_tts_task_key(conversation_id, message_id)
        with cls._assistant_tts_tasks_lock:
            existing_task = cls._assistant_tts_tasks.get(task_key)
            if existing_task and not existing_task.done():
                return False
            cls._assistant_tts_tasks[task_key] = cls._assistant_tts_executor.submit(
                cls._run_assistant_tts_task,
                user_id,
                conversation_id,
                message_id,
            )
        return True

    @classmethod
    def _clear_assistant_tts_task(cls, conversation_id: str, message_id: str) -> None:
        task_key = cls._assistant_tts_task_key(conversation_id, message_id)
        with cls._assistant_tts_tasks_lock:
            cls._assistant_tts_tasks.pop(task_key, None)

    @classmethod
    def _persist_assistant_tts_failure(
        cls,
        *,
        user_id: str,
        conversation_id: str,
        message_id: str,
        error: str,
        mime_type: str | None = None,
    ) -> None:
        try:
            conv = cls._load_conversation(conversation_id, user_id)
            idx = _message_index_by_id_and_role(conv, message_id, "assistant")
            if idx < 0:
                return
            cls._set_assistant_voice(
                conv,
                idx,
                status="failed",
                mime_type=mime_type,
                error=error,
            )
            _persist_conversation(conv)
        except Exception:
            logging.exception(
                "persist assistant tts failure state failed for %s/%s",
                conversation_id,
                message_id,
            )

    @classmethod
    def _run_assistant_tts_task(
        cls,
        user_id: str,
        conversation_id: str,
        message_id: str,
    ) -> None:
        try:
            conv = cls._load_conversation(conversation_id, user_id)
            idx = _message_index_by_id_and_role(conv, message_id, "assistant")
            if idx < 0:
                return

            dialog = cls._load_dialog(conv)
            if not dialog.prompt_config.get("tts"):
                cls._persist_assistant_tts_failure(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=message_id,
                    error="tts_disabled",
                )
                return

            text = clean_tts_text(conv.message[idx].get("content") or "")
            if not text:
                cls._persist_assistant_tts_failure(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=message_id,
                    error="no_readable_content",
                )
                return

            tts_mdl = cls._try_build_tts_model(dialog)
            if not tts_mdl:
                cls._persist_assistant_tts_failure(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=message_id,
                    error="tts_unavailable",
                )
                return

            mime_type = _normalize_audio_mime_type(
                getattr(getattr(tts_mdl, "mdl", None), "last_mime_type", None),
            )
            audio = bytearray()
            for chunk in tts_mdl.tts(text):
                if isinstance(chunk, (bytes, bytearray)) and chunk:
                    audio.extend(chunk)

            if not audio:
                cls._persist_assistant_tts_failure(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=message_id,
                    error="tts_empty",
                    mime_type=mime_type,
                )
                return

            file_id = VoiceStorageService.build_assistant_final_key(
                conv.id,
                message_id,
                mime_type,
            )
            VoiceStorageService.save_blob(conv.user_id or user_id, file_id, bytes(audio))

            conv = cls._load_conversation(conversation_id, user_id)
            idx = _message_index_by_id_and_role(conv, message_id, "assistant")
            if idx < 0:
                return
            cls._set_assistant_voice(
                conv,
                idx,
                status="ready",
                mime_type=mime_type,
                file_id=file_id,
            )
            _persist_conversation(conv)
        except Exception:
            logging.exception(
                "assistant async tts failed for %s/%s",
                conversation_id,
                message_id,
            )
            cls._persist_assistant_tts_failure(
                user_id=user_id,
                conversation_id=conversation_id,
                message_id=message_id,
                error="tts_failed",
            )
        finally:
            cls._clear_assistant_tts_task(conversation_id, message_id)

    @classmethod
    def persist_assistant_tts_segment(
        cls,
        user_id: str,
        conversation_id: str,
        message_id: str,
        seq: int,
        text: str,
        audio: bytes,
        mime_type: str,
        final: bool = False,
    ) -> dict[str, Any]:
        if not audio:
            raise ValueError("audio is required")

        conv = cls._load_conversation(conversation_id, user_id)
        idx = _message_index_by_id_and_role(conv, message_id, "assistant")
        if idx < 0:
            raise LookupError("Assistant message not found!")

        owner_id = conv.user_id or user_id
        normalized_mime_type = _normalize_audio_mime_type(
            mime_type,
            default=DEFAULT_TTS_MIME_TYPE,
        )
        file_id = VoiceStorageService.build_assistant_segment_key(
            conv.id,
            message_id,
            seq,
            normalized_mime_type,
        )
        VoiceStorageService.save_blob(owner_id, file_id, audio)

        message = conv.message[idx]
        voice = message.setdefault("voice", {})
        segments = [
            segment
            for segment in (voice.get("segments") or [])
            if int(segment.get("seq", -1)) != int(seq)
        ]
        segments.append(
            {
                "seq": int(seq),
                "file_id": file_id,
                "mime_type": normalized_mime_type,
                "duration_ms": 0,
                "text": text,
            }
        )
        segments.sort(key=lambda item: int(item.get("seq", 0)))

        voice["kind"] = "segments"
        voice["status"] = "ready" if final else "partial"
        voice["mime_type"] = normalized_mime_type
        voice["segments"] = segments
        voice.pop("file_id", None)
        voice.pop("error", None)
        message["voice"] = voice
        message["created_at"] = _now_ts()
        conv.message[idx] = message
        _persist_conversation(conv)
        return segments[-1]

    @classmethod
    def finalize_assistant_tts_segments(
        cls,
        *,
        user_id: str,
        conversation_id: str,
        message_id: str,
    ) -> None:
        conv = cls._load_conversation(conversation_id, user_id)
        idx = _message_index_by_id_and_role(conv, message_id, "assistant")
        if idx < 0:
            raise LookupError("Assistant message not found!")

        message = conv.message[idx]
        voice = message.get("voice") or {}
        if voice.get("kind") != "segments":
            raise LookupError("Assistant voice segments not found!")

        segments = voice.get("segments") or []
        if not segments:
            raise LookupError("Assistant voice segments are empty!")

        voice["status"] = "ready"
        voice.pop("error", None)
        message["voice"] = voice
        message["created_at"] = _now_ts()
        conv.message[idx] = message
        _persist_conversation(conv)

    @staticmethod
    def _load_conversation(conversation_id: str, user_id: str):
        ok, conv = ConversationService.get_by_id(conversation_id)
        if not ok or not conv:
            raise LookupError("Conversation not found!")
        if conv.user_id and conv.user_id != user_id:
            raise PermissionError("Only owner of conversation authorized for this operation.")
        return conv

    @staticmethod
    def _load_dialog(conv):
        ok, dialog = DialogService.get_by_id(conv.dialog_id)
        if not ok or not dialog:
            raise LookupError("Dialog not found!")
        return dialog

    @classmethod
    def get_assistant_message(
        cls,
        *,
        user_id: str,
        conversation_id: str,
        message_id: str,
    ) -> dict[str, Any]:
        conv = cls._load_conversation(conversation_id, user_id)
        idx = _message_index_by_id_and_role(conv, message_id, "assistant")
        if idx < 0:
            raise LookupError("Assistant message not found!")
        return _clone_message(conv.message[idx])

    @classmethod
    def wait_for_assistant_tts_message(
        cls,
        *,
        user_id: str,
        conversation_id: str,
        message_id: str,
        timeout: float = 90.0,
    ) -> dict[str, Any]:
        timeout = max(float(timeout or 0), 0.0)
        deadline = time.monotonic() + timeout

        while True:
            message = cls.get_assistant_message(
                user_id=user_id,
                conversation_id=conversation_id,
                message_id=message_id,
            )
            voice = message.get("voice") or {}
            status = voice.get("status")
            if (
                voice.get("kind") != "single"
                or status in {"ready", "failed"}
                or voice.get("file_id")
                or voice.get("error")
            ):
                return message

            future = cls._get_assistant_tts_task(conversation_id, message_id)
            if future is not None:
                remaining = max(deadline - time.monotonic(), 0.0)
                if remaining <= 0:
                    return message
                try:
                    future.result(timeout=remaining)
                except FutureTimeoutError:
                    return cls.get_assistant_message(
                        user_id=user_id,
                        conversation_id=conversation_id,
                        message_id=message_id,
                    )
                except Exception:
                    return cls.get_assistant_message(
                        user_id=user_id,
                        conversation_id=conversation_id,
                        message_id=message_id,
                    )
                continue

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return message
            time.sleep(min(0.2, remaining))

    @staticmethod
    def _try_build_tts_model(dialog):
        if not dialog.prompt_config.get("tts"):
            return None
        try:
            return LLMBundle(dialog.tenant_id, LLMType.TTS)
        except Exception as exc:
            logging.warning("voice tts init failed: %s", exc)
            return None

    @classmethod
    async def _transcribe_existing_user_message(
        cls,
        conv,
        message_id: str,
        user_id: str,
    ) -> dict[str, Any]:
        idx = _message_index(conv, message_id)
        if idx < 0:
            raise LookupError("Voice message not found!")

        message = conv.message[idx]
        voice = message.get("voice") or {}
        file_id = voice.get("file_id")
        if not file_id:
            raise LookupError("Voice blob not found!")

        blob = VoiceStorageService.get_blob(conv.user_id or user_id, file_id)
        mime_type = voice.get("mime_type", "audio/webm")
        filename = file_id.split("/")[-1] or "voice.webm"

        transcript = await ExternalASRService.transcribe(blob, filename, mime_type)
        message["content"] = transcript
        message.setdefault("voice", {})["status"] = "ready"
        message["voice"].pop("error", None)
        message["created_at"] = _now_ts()
        conv.message[idx] = message
        _persist_conversation(conv)
        return message

    @classmethod
    def _append_assistant_placeholder(cls, conv, with_voice: bool) -> dict[str, Any]:
        existing_ids = {message.get("id") for message in (conv.message or []) if message.get("id")}
        assistant_id = str(uuid4())
        while assistant_id in existing_ids:
            assistant_id = str(uuid4())
        assistant_message = (
            _build_assistant_voice_message(assistant_id)
            if with_voice
            else _base_voice_message(assistant_id, "assistant", "text")
        )
        if not conv.reference:
            conv.reference = []
        conv.reference.append({"chunks": [], "doc_aggs": []})
        conv.message.append(assistant_message)
        _persist_conversation(conv)
        return assistant_message

    @classmethod
    async def _stream_assistant_reply(
        cls,
        conv,
        dialog,
        user_id: str,
    ) -> AsyncGenerator[dict[str, Any], None]:
        tts_enabled = bool(dialog.prompt_config.get("tts"))
        chat_messages = _conversation_messages_for_chat(conv.message)
        assistant_message = cls._append_assistant_placeholder(conv, with_voice=tts_enabled)
        yield _stream_event("assistant_started", {"message": _clone_message(assistant_message)})

        assistant_idx = len(conv.message) - 1
        reference = {"chunks": [], "doc_aggs": []}

        try:
            if not tts_enabled:
                async for ans in async_chat(dialog, chat_messages, True, enable_tts=False):
                    if ans.get("final"):
                        reference = ans.get("reference") or {"chunks": [], "doc_aggs": []}
                        continue

                    delta = ans.get("answer") or ""
                    if not delta:
                        continue

                    conv.message[assistant_idx]["id"] = assistant_message["id"]
                    conv.message[assistant_idx]["role"] = "assistant"
                    conv.message[assistant_idx]["content"] += delta
                    conv.message[assistant_idx]["created_at"] = _now_ts()

                    yield _stream_event(
                        "assistant_delta",
                        {
                            "message_id": assistant_message["id"],
                            "delta": delta,
                        },
                    )

                conv.message[assistant_idx]["id"] = assistant_message["id"]
                conv.message[assistant_idx]["role"] = "assistant"
                conv.message[assistant_idx]["created_at"] = _now_ts()
                conv.reference[-1] = reference
                _persist_conversation(conv)
                final_message = copy.deepcopy(conv.message[assistant_idx])
            else:
                full_answer = None
                async for ans in async_chat(dialog, chat_messages, False, enable_tts=False):
                    full_answer = ans
                    break

                if full_answer is None:
                    raise RuntimeError("assistant_empty_reply")

                answer_text = full_answer.get("answer") or ""
                reference = full_answer.get("reference") or {"chunks": [], "doc_aggs": []}

                conv.message[assistant_idx]["id"] = assistant_message["id"]
                conv.message[assistant_idx]["role"] = "assistant"
                conv.message[assistant_idx]["content"] = answer_text
                conv.message[assistant_idx]["created_at"] = _now_ts()
                conv.reference[-1] = reference

                latest_message = None
                try:
                    cleaned_text = cls.prepare_assistant_tts_message(
                        conv,
                        assistant_message["id"],
                        answer_text,
                    )
                    _persist_conversation(conv)

                    if cleaned_text:
                        cls.enqueue_assistant_tts_task(
                            user_id=user_id,
                            conversation_id=conv.id,
                            message_id=assistant_message["id"],
                        )
                        latest_message = await asyncio.to_thread(
                            cls.wait_for_assistant_tts_message,
                            user_id=user_id,
                            conversation_id=conv.id,
                            message_id=assistant_message["id"],
                            timeout=180.0,
                        )
                    else:
                        latest_message = await asyncio.to_thread(
                            cls.get_assistant_message,
                            user_id=user_id,
                            conversation_id=conv.id,
                            message_id=assistant_message["id"],
                        )
                except Exception:
                    logging.exception(
                        "assistant tts failed for %s/%s",
                        conv.id,
                        assistant_message["id"],
                    )
                    cls._set_assistant_voice(
                        conv,
                        assistant_idx,
                        status="failed",
                        error="tts_failed",
                    )
                    conv.reference[-1] = reference
                    _persist_conversation(conv)
                    latest_message = copy.deepcopy(conv.message[assistant_idx])

                conv.message[assistant_idx] = latest_message
                conv.reference[-1] = reference
                _persist_conversation(conv)

                text_chunks = split_answer_for_pseudo_stream(answer_text)
                voice_payload = copy.deepcopy((latest_message.get("voice") or None))
                for index, delta in enumerate(text_chunks):
                    event = {
                        "message_id": assistant_message["id"],
                        "delta": delta,
                    }
                    if index == 0 and voice_payload:
                        event["voice"] = voice_payload

                    yield _stream_event("assistant_delta", event)
                    if index < len(text_chunks) - 1:
                        await asyncio.sleep(pseudo_stream_delay_for_chunk(delta))

                final_message = copy.deepcopy(conv.message[assistant_idx])

            final_message["reference"] = reference
            yield _stream_event(
                "assistant_done",
                {
                    "message": final_message,
                    "reference": reference,
                },
            )
        except Exception as exc:
            logging.exception(exc)
            if tts_enabled:
                cls._set_assistant_voice(
                    conv,
                    assistant_idx,
                    status="failed",
                    error="llm_failed",
                )
            conv.message[assistant_idx]["id"] = assistant_message["id"]
            conv.message[assistant_idx]["role"] = "assistant"
            conv.message[assistant_idx]["content"] = conv.message[assistant_idx]["content"] or f"**ERROR**: {exc}"
            if conv.reference:
                conv.reference[-1] = reference
            _persist_conversation(conv)
            yield _stream_event(
                "error",
                {
                    "stage": "llm",
                    "message": str(exc),
                    "message_id": assistant_message["id"],
                    "message": _clone_message(conv.message[assistant_idx]),
                    "reference": reference,
                    "recoverable": False,
                },
                code=500,
            )

    @classmethod
    async def stream_voice_completion(
        cls,
        *,
        user_id: str,
        conversation_id: str,
        client_message_id: str,
        filename: str,
        mime_type: str,
        duration_ms: int,
        waveform: list[int] | None,
        audio_bytes: bytes,
    ) -> AsyncGenerator[dict[str, Any], None]:
        conv = cls._load_conversation(conversation_id, user_id)
        dialog = cls._load_dialog(conv)

        file_id = VoiceStorageService.build_user_voice_key(
            conversation_id,
            client_message_id,
            filename,
            mime_type,
        )
        VoiceStorageService.save_blob(user_id, file_id, audio_bytes)

        user_message = _build_user_voice_message(
            client_message_id,
            file_id,
            mime_type or "audio/webm",
            duration_ms,
            waveform,
        )
        conv.message = conv.message or []
        conv.message.append(user_message)
        _persist_conversation(conv)

        yield _stream_event(
            "user_message_persisted",
            {
                "client_message_id": client_message_id,
                "message": _clone_message(user_message),
            },
        )

        try:
            transcript = await ExternalASRService.transcribe(audio_bytes, filename, mime_type)
            idx = _message_index(conv, client_message_id)
            conv.message[idx]["content"] = transcript
            conv.message[idx]["voice"]["status"] = "ready"
            conv.message[idx]["voice"].pop("error", None)
            conv.message[idx]["created_at"] = _now_ts()
            _persist_conversation(conv)

            yield _stream_event(
                "user_message_ready",
                {
                    "client_message_id": client_message_id,
                    "message": _clone_message(conv.message[idx]),
                },
            )
        except Exception as exc:
            logging.exception(exc)
            idx = _message_index(conv, client_message_id)
            conv.message[idx]["voice"]["status"] = "failed"
            conv.message[idx]["voice"]["error"] = "asr_failed"
            _persist_conversation(conv)
            yield _stream_event(
                "error",
                {
                    "stage": "asr",
                    "message": str(exc),
                    "client_message_id": client_message_id,
                    "recoverable": True,
                },
                code=500,
            )
            yield _stream_event("done", True)
            return

        async for event in cls._stream_assistant_reply(conv, dialog, user_id):
            yield event

        yield _stream_event("done", True)

    @classmethod
    async def stream_retry_voice_completion(
        cls,
        *,
        user_id: str,
        conversation_id: str,
        message_id: str,
    ) -> AsyncGenerator[dict[str, Any], None]:
        conv = cls._load_conversation(conversation_id, user_id)
        dialog = cls._load_dialog(conv)

        idx = _message_index(conv, message_id)
        if idx < 0:
            raise LookupError("Voice message not found!")

        conv.message[idx].setdefault("voice", {})["status"] = "transcribing"
        conv.message[idx]["voice"].pop("error", None)
        conv.message[idx]["created_at"] = _now_ts()
        _persist_conversation(conv)

        yield _stream_event(
            "user_message_persisted",
            {
                "client_message_id": message_id,
                "message": _clone_message(conv.message[idx]),
            },
        )

        try:
            message = await cls._transcribe_existing_user_message(conv, message_id, user_id)
            yield _stream_event(
                "user_message_ready",
                {
                    "client_message_id": message_id,
                    "message": _clone_message(message),
                },
            )
        except Exception as exc:
            logging.exception(exc)
            idx = _message_index(conv, message_id)
            conv.message[idx].setdefault("voice", {})["status"] = "failed"
            conv.message[idx]["voice"]["error"] = "asr_failed"
            _persist_conversation(conv)
            yield _stream_event(
                "error",
                {
                    "stage": "asr",
                    "message": str(exc),
                    "client_message_id": message_id,
                    "recoverable": True,
                },
                code=500,
            )
            yield _stream_event("done", True)
            return

        async for event in cls._stream_assistant_reply(conv, dialog, user_id):
            yield event

        yield _stream_event("done", True)

    @classmethod
    def get_voice_blob_for_message(
        cls,
        *,
        user_id: str,
        conversation_id: str,
        message_id: str,
        seq: int | None = None,
        role: str | None = None,
    ) -> tuple[bytes, str]:
        conv = cls._load_conversation(conversation_id, user_id)
        idx = _voice_message_index(conv, message_id, seq, role)
        if idx < 0:
            raise LookupError("Voice message not found!")

        message = conv.message[idx]
        voice = message.get("voice") or {}
        if voice.get("kind") == "single":
            file_id = voice.get("file_id")
            mime_type = voice.get("mime_type", "audio/webm")
            if not file_id:
                raise LookupError("Voice blob not found!")
            return VoiceStorageService.get_blob(conv.user_id or user_id, file_id), mime_type

        if seq is None and voice.get("file_id"):
            return (
                VoiceStorageService.get_blob(conv.user_id or user_id, voice["file_id"]),
                voice.get("mime_type", DEFAULT_TTS_MIME_TYPE),
            )

        segments = voice.get("segments") or []
        if seq is None:
            if len(segments) == 1:
                segment = segments[0]
                return (
                    VoiceStorageService.get_blob(conv.user_id or user_id, segment["file_id"]),
                    segment.get("mime_type", "audio/mpeg"),
                )
            raise LookupError("Segment seq is required")
        segment = next((item for item in segments if int(item.get("seq", -1)) == int(seq)), None)
        if not segment:
            raise LookupError("Voice segment not found!")
        return (
            VoiceStorageService.get_blob(conv.user_id or user_id, segment["file_id"]),
            segment.get("mime_type", "audio/mpeg"),
        )
