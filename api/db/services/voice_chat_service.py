import copy
import logging
import time
from typing import Any, AsyncGenerator
from uuid import uuid4

from api.db.services.conversation_service import ConversationService
from api.db.services.dialog_service import async_chat, clean_tts_text
from api.db.services.dialog_service import DialogService
from api.db.services.external_asr_service import ExternalASRService
from api.db.services.voice_storage_service import VoiceStorageService
from api.db.services.llm_service import LLMBundle
from common.constants import LLMType
from common.misc_utils import get_uuid


DEFAULT_TTS_MIME_TYPE = "audio/mpeg"


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


def _tts_bytes(tts_mdl, text: str) -> tuple[bytes | None, str]:
    if not tts_mdl:
        return None, DEFAULT_TTS_MIME_TYPE
    text = clean_tts_text(text)
    if not text:
        return None, DEFAULT_TTS_MIME_TYPE
    audio = b""
    for chunk in tts_mdl.tts(text):
        audio += chunk
    mime_type = _normalize_audio_mime_type(
        getattr(getattr(tts_mdl, "mdl", None), "last_mime_type", None),
        default=DEFAULT_TTS_MIME_TYPE,
    )
    return audio or None, mime_type


class VoiceChatService:
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
    ) -> AsyncGenerator[dict[str, Any], None]:
        tts_mdl = cls._try_build_tts_model(dialog)
        chat_messages = _conversation_messages_for_chat(conv.message)
        assistant_message = cls._append_assistant_placeholder(conv, with_voice=bool(tts_mdl))
        yield _stream_event("assistant_started", {"message": _clone_message(assistant_message)})

        assistant_idx = len(conv.message) - 1
        reference = {"chunks": [], "doc_aggs": []}

        try:
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

            if tts_mdl:
                voice_meta = conv.message[assistant_idx].setdefault("voice", {})
                try:
                    final_audio, final_mime_type = _tts_bytes(
                        tts_mdl,
                        conv.message[assistant_idx].get("content", ""),
                    )
                    if final_audio:
                        final_file_id = VoiceStorageService.build_assistant_final_key(
                            conv.id,
                            assistant_message["id"],
                            final_mime_type,
                        )
                        VoiceStorageService.save_blob(
                            conv.user_id,
                            final_file_id,
                            final_audio,
                        )
                        voice_meta["kind"] = "single"
                        voice_meta["status"] = "ready"
                        voice_meta["file_id"] = final_file_id
                        voice_meta["mime_type"] = final_mime_type
                        voice_meta.pop("error", None)
                    else:
                        voice_meta["kind"] = "single"
                        voice_meta["status"] = "failed"
                        voice_meta["mime_type"] = DEFAULT_TTS_MIME_TYPE
                        voice_meta["error"] = "tts_empty"
                        voice_meta.pop("file_id", None)
                except Exception as exc:
                    logging.warning("assistant final full tts failed: %s", exc)
                    voice_meta["kind"] = "single"
                    voice_meta["status"] = "failed"
                    voice_meta["mime_type"] = _normalize_audio_mime_type(
                        voice_meta.get("mime_type"),
                        default=DEFAULT_TTS_MIME_TYPE,
                    )
                    voice_meta["error"] = "tts_failed"
                    voice_meta.pop("file_id", None)

            conv.message[assistant_idx]["id"] = assistant_message["id"]
            conv.message[assistant_idx]["role"] = "assistant"
            conv.message[assistant_idx]["created_at"] = _now_ts()
            conv.reference[-1] = reference
            _persist_conversation(conv)

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
            if tts_mdl:
                voice_meta = conv.message[assistant_idx].get("voice") or {}
                voice_meta["kind"] = "single"
                voice_meta["status"] = "failed"
                voice_meta["error"] = "llm_failed"
                voice_meta.pop("file_id", None)
                conv.message[assistant_idx]["voice"] = voice_meta
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

        async for event in cls._stream_assistant_reply(conv, dialog):
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

        async for event in cls._stream_assistant_reply(conv, dialog):
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
            raise LookupError("Segment seq is required")
        segment = next((item for item in segments if int(item.get("seq", -1)) == int(seq)), None)
        if not segment:
            raise LookupError("Voice segment not found!")
        return (
            VoiceStorageService.get_blob(conv.user_id or user_id, segment["file_id"]),
            segment.get("mime_type", "audio/mpeg"),
        )
