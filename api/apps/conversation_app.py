#
#  Copyright 2024 The InfiniFlow Authors. All Rights Reserved.
#
#  Licensed under the Apache License, Version 2.0 (the "License");
#  you may not use this file except in compliance with the License.
#  You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
#  Unless required by applicable law or agreed to in writing, software
#  distributed under the License is distributed on an "AS IS" BASIS,
#  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#  See the License for the specific language governing permissions and
#  limitations under the License.
#
import asyncio
import json
import os
import re
import logging
import time
from copy import deepcopy
import tempfile
from peewee import IntegrityError
from quart import Response, request
from api.apps import current_user, login_required
from api.db.db_models import APIToken
from api.db.services.conversation_service import ConversationService, structure_answer
from api.db.services.dialog_service import DialogService, async_ask, async_chat, clean_tts_text, gen_mindmap
from api.db.services.llm_service import LLMBundle
from api.db.services.print_service import ConversationPrintService
from api.db.services.search_service import SearchService
from api.db.services.tenant_llm_service import TenantLLMService
from api.db.services.user_service import TenantService, UserTenantService
from api.db.services.voice_chat_service import (
    VoiceChatService,
    pseudo_stream_delay_for_chunk,
    split_answer_for_pseudo_stream,
)
from api.utils.api_utils import get_data_error_result, get_json_result, get_request_json, server_error_response, validate_request
from api.utils.conversation_export import (
    build_download_filename,
    generate_markdown,
    generate_table_markdown,
    markdown_to_pdf_bytes,
)
from rag.prompts.template import load_prompt
from rag.prompts.generator import chunks_format
from common.constants import RetCode, LLMType


_CONVERSATION_RESPONSE_MESSAGE_DROP_FIELDS = {
    "answer",
    "audio_binary",
    "audio_mime_type",
    "final",
    "prompt",
    "reference",
    "session_id",
}
_CONVERSATION_STORAGE_MESSAGE_DROP_FIELDS = _CONVERSATION_RESPONSE_MESSAGE_DROP_FIELDS | {
    "chatBoxId",
    "conversationId",
    "data",
}


def _merge_latest_voice_state(conv):
    if not conv or not getattr(conv, "id", None):
        return conv

    ok, latest_conv = ConversationService.get_by_id(conv.id)
    if not ok or not latest_conv:
        return conv

    latest_messages = latest_conv.message or []
    latest_voice_map = {}
    for message in latest_messages:
        key = (message.get("id"), message.get("role"))
        if key[0] and message.get("voice") is not None:
            latest_voice_map[key] = deepcopy(message.get("voice"))

    if not latest_voice_map:
        return conv

    for message in conv.message or []:
        key = (message.get("id"), message.get("role"))
        latest_voice = latest_voice_map.get(key)
        if latest_voice is None:
            continue
        if message.get("voice"):
            current_voice = message.get("voice") or {}
            merged_voice = deepcopy(current_voice)
            merged_voice.update(deepcopy(latest_voice))
            if current_voice.get("segments") and not latest_voice.get("segments"):
                merged_voice["segments"] = current_voice["segments"]
            message["voice"] = merged_voice
        else:
            message["voice"] = deepcopy(latest_voice)

    return conv


def _finalize_live_tts_segments(conv, message_id):
    if not conv or not message_id:
        return conv

    for message in reversed(conv.message or []):
        if message.get("id") != message_id or message.get("role") != "assistant":
            continue

        voice = message.get("voice") or {}
        if voice.get("kind") != "segments":
            return conv

        segments = voice.get("segments") or []
        if not segments:
            return conv

        if voice.get("status") in {"partial", "streaming"}:
            voice["status"] = "ready"
            message["voice"] = voice
        return conv

    return conv


def _sanitize_voice_payload(voice):
    if not isinstance(voice, dict):
        return voice

    next_voice = deepcopy(voice)
    next_voice.pop("local_url", None)

    segments = next_voice.get("segments")
    if isinstance(segments, list):
        cleaned_segments = []
        for segment in segments:
            if not isinstance(segment, dict):
                cleaned_segments.append(segment)
                continue
            next_segment = deepcopy(segment)
            next_segment.pop("object_url", None)
            cleaned_segments.append(next_segment)
        next_voice["segments"] = cleaned_segments

    return next_voice


def _sanitize_conversation_message(message, drop_fields):
    if not isinstance(message, dict):
        return message

    next_message = deepcopy(message)
    for field in drop_fields:
        next_message.pop(field, None)

    if "voice" in next_message:
        next_message["voice"] = _sanitize_voice_payload(next_message.get("voice"))

    return next_message


def _sanitize_conversation_messages(messages, drop_fields):
    return [
        _sanitize_conversation_message(message, drop_fields)
        for message in (messages or [])
    ]


def _get_owned_conversation(conversation_id: str):
    ok, conv = ConversationService.get_by_id(conversation_id)
    if not ok or not conv:
        return None, get_data_error_result(message="会话不存在")

    if getattr(conv, "user_id", None) and conv.user_id != current_user.id:
        return None, get_data_error_result(message="无权访问该会话")

    ok, dialog = DialogService.get_by_id(conv.dialog_id)
    if not ok or not dialog:
        return None, get_data_error_result(message="对话不存在")

    tenant_id = UserTenantService.get_tenant_id_by_user_id(current_user.id)
    allowed_tenant_ids = {current_user.id}
    if tenant_id:
        allowed_tenant_ids.add(tenant_id)

    if getattr(dialog, "tenant_id", None) and dialog.tenant_id not in allowed_tenant_ids:
        return None, get_data_error_result(message="无权访问该对话")

    return (conv, dialog), None


def _normalize_tts_mime_type(mime_type: str | None, default: str = "audio/mpeg") -> str:
    if not mime_type:
        return default
    return mime_type.split(";", 1)[0].strip().lower() or default


def _tts_text_len(text: str) -> int:
    return len(re.sub(r"\s+", "", text or ""))


def _split_failed_tts_segment(text: str) -> list[str]:
    normalized = (text or "").strip()
    if _tts_text_len(normalized) < 24:
        return [normalized] if normalized else []

    midpoint = len(normalized) // 2
    split_points = []
    for index, char in enumerate(normalized):
        if char not in "。！？；，、,.!?;\n":
            continue
        left = normalized[: index + 1].strip()
        right = normalized[index + 1 :].strip()
        if _tts_text_len(left) < 8 or _tts_text_len(right) < 8:
            continue
        split_points.append((abs(index - midpoint), index))

    if split_points:
        _, split_index = min(split_points)
        return [
            normalized[: split_index + 1].strip(),
            normalized[split_index + 1 :].strip(),
        ]

    for split_index in range(midpoint, len(normalized)):
        left = normalized[:split_index].strip()
        right = normalized[split_index:].strip()
        if _tts_text_len(left) >= 8 and _tts_text_len(right) >= 8:
            return [left, right]

    return [normalized] if normalized else []


def _split_tts_for_backend(text: str, max_chars: int = 45) -> list[str]:
    normalized = (text or "").strip()
    if not normalized:
        return []

    clauses = []
    buffer = ""
    for char in normalized:
        buffer += char
        if char in "。！？；，、,.!?;\n":
            clauses.append(buffer.strip())
            buffer = ""
    if buffer.strip():
        clauses.append(buffer.strip())

    outputs = []
    current = ""
    for clause in clauses:
        if not clause:
            continue

        if _tts_text_len(clause) > max_chars:
            if current:
                outputs.append(current.strip())
                current = ""
            parts = _split_failed_tts_segment(clause)
            if len(parts) <= 1:
                outputs.append(clause)
            else:
                for part in parts:
                    outputs.extend(_split_tts_for_backend(part, max_chars=max_chars))
            continue

        candidate = f"{current}{clause}" if current else clause
        if current and _tts_text_len(candidate) > max_chars:
            outputs.append(current.strip())
            current = clause
        else:
            current = candidate

    if current:
        outputs.append(current.strip())

    return [item for item in outputs if item]


def _generate_and_persist_tts_segment(
    *,
    dialog,
    user_id: str,
    conversation_id: str,
    message_id: str,
    seq: int,
    text: str,
) -> dict:
    cleaned_text = clean_tts_text(text)
    if not cleaned_text:
        raise ValueError("no_readable_content")

    tts_mdl = VoiceChatService._try_build_tts_model(dialog)
    if not tts_mdl:
        raise RuntimeError("tts_unavailable")

    audio = bytearray()
    for chunk in tts_mdl.tts(cleaned_text):
        if isinstance(chunk, (bytes, bytearray)) and chunk:
            audio.extend(chunk)

    mime_type = _normalize_tts_mime_type(
        getattr(getattr(tts_mdl, "mdl", None), "last_mime_type", None),
    )
    if not audio:
        raise RuntimeError("tts_empty")

    segment = VoiceChatService.persist_assistant_tts_segment(
        user_id=user_id,
        conversation_id=conversation_id,
        message_id=message_id,
        seq=seq,
        text=cleaned_text,
        audio=bytes(audio),
        mime_type=mime_type,
        final=False,
    )

    return {
        "segment": segment,
        "mime_type": mime_type,
    }


def _build_segment_voice_answer(
    *,
    message_id: str,
    session_id: str,
    status: str,
    mime_type: str | None,
    final: bool = False,
    segments: list | None = None,
    error: str | None = None,
) -> dict:
    voice = {
        "kind": "segments",
        "status": status,
        "mime_type": _normalize_tts_mime_type(mime_type),
        "segments": segments or [],
    }
    if error:
        voice["error"] = error

    return {
        "answer": "",
        "reference": {},
        "audio_binary": None,
        "audio_mime_type": voice["mime_type"],
        "prompt": "",
        "created_at": time.time(),
        "final": final,
        "id": message_id,
        "session_id": session_id,
        "voice": voice,
    }


async def _collect_full_chat_answer(
    dialog,
    messages,
    *,
    model_tenant_id=None,
    **kwargs,
) -> dict:
    answer = None
    async for ans in async_chat(
        dialog,
        messages,
        False,
        model_tenant_id=model_tenant_id,
        **kwargs,
    ):
        answer = ans
        break

    if answer is None:
        raise RuntimeError("assistant_empty_reply")

    return answer


async def _yield_pseudo_stream_answers(
    *,
    structured_answer: dict,
    voice_message: dict | None = None,
):
    full_text = structured_answer.get("answer") or ""
    text_chunks = split_answer_for_pseudo_stream(full_text) or [""]
    voice_payload = None
    if voice_message:
        voice_payload = _sanitize_voice_payload(voice_message.get("voice"))
    if voice_payload is None:
        voice_payload = _sanitize_voice_payload(structured_answer.get("voice"))

    for index, chunk in enumerate(text_chunks):
        is_last = index == len(text_chunks) - 1
        payload = {
            "answer": chunk,
            "reference": structured_answer.get("reference") if is_last else {},
            "audio_binary": None,
            "audio_mime_type": (
                (voice_payload or {}).get("mime_type")
                or structured_answer.get("audio_mime_type")
            ),
            "prompt": structured_answer.get("prompt") if is_last else "",
            "created_at": structured_answer.get("created_at", time.time()),
            "final": is_last,
            "id": structured_answer.get("id"),
            "session_id": structured_answer.get("session_id"),
        }
        if voice_payload and index == 0:
            payload["voice"] = deepcopy(voice_payload)

        yield payload
        if not is_last and len(text_chunks) > 1:
            await asyncio.sleep(pseudo_stream_delay_for_chunk(chunk))


@manager.route("/set", methods=["POST"])  # noqa: F821
@login_required
async def set_conversation():
    req = await get_request_json()
    conv_id = req.get("conversation_id")
    is_new = req.get("is_new")
    name = req.get("name", "New conversation")
    req["user_id"] = current_user.id

    if len(name) > 255:
        name = name[0:255]

    del req["is_new"]
    if not is_new:
        del req["conversation_id"]
        try:
            if not ConversationService.update_by_id(conv_id, req):
                return get_data_error_result(message="Conversation not found!")
            e, conv = ConversationService.get_by_id(conv_id)
            if not e:
                return get_data_error_result(message="Fail to update a conversation!")
            conv = conv.to_dict()
            return get_json_result(data=conv)
        except Exception as e:
            return server_error_response(e)

    try:
        e, dia = DialogService.get_by_id(req["dialog_id"])
        if not e:
            return get_data_error_result(message="Dialog not found")
        existing, existing_conv = ConversationService.get_by_id(conv_id)
        if existing and existing_conv:
            if str(existing_conv.user_id) != str(current_user.id):
                return get_json_result(
                    data=False,
                    message="Only owner of conversation authorized for this operation.",
                    code=RetCode.OPERATING_ERROR,
                )
            return get_json_result(data=existing_conv.to_dict())
        conv = {
            "id": conv_id,
            "dialog_id": req["dialog_id"],
            "name": name,
            "message": [{
                "role": "assistant",
                "content": dia.prompt_config["prologue"],
                "id": conv_id,
            }],
            "user_id": current_user.id,
            "reference": [],
        }
        ConversationService.save(**conv)
        return get_json_result(data=conv)
    except IntegrityError:
        existing, existing_conv = ConversationService.get_by_id(conv_id)
        if existing and existing_conv and str(existing_conv.user_id) == str(current_user.id):
            return get_json_result(data=existing_conv.to_dict())
        return get_data_error_result(message="Conversation already exists!")
    except Exception as e:
        return server_error_response(e)


@manager.route("/get", methods=["GET"])  # noqa: F821
@login_required
async def get():
    conv_id = request.args["conversation_id"]
    try:
        e, conv = ConversationService.get_by_id(conv_id)
        if not e:
            return get_data_error_result(message="Conversation not found!")
        tenants = UserTenantService.query(user_id=current_user.id)
        for tenant in tenants:
            dialog = DialogService.query(tenant_id=tenant.tenant_id, id=conv.dialog_id)
            if dialog and len(dialog) > 0:
                avatar = dialog[0].icon
                break
        else:
            return get_json_result(data=False, message="Only owner of conversation authorized for this operation.", code=RetCode.OPERATING_ERROR)

        for ref in conv.reference:
            if isinstance(ref, list):
                continue
            ref["chunks"] = chunks_format(ref)

        conv = conv.to_dict()
        conv["message"] = _sanitize_conversation_messages(
            conv.get("message"),
            _CONVERSATION_RESPONSE_MESSAGE_DROP_FIELDS,
        )
        conv["avatar"] = avatar
        return get_json_result(data=conv)
    except Exception as e:
        return server_error_response(e)


@manager.route("/getsse/<dialog_id>", methods=["GET"])  # type: ignore # noqa: F821
def getsse(dialog_id):
    token = request.headers.get("Authorization").split()
    if len(token) != 2:
        return get_data_error_result(message='Authorization is not valid!"')
    token = token[1]
    objs = APIToken.query(beta=token)
    if not objs:
        return get_data_error_result(message='Authentication error: API key is invalid!"')
    try:
        e, conv = DialogService.get_by_id(dialog_id)
        if not e:
            return get_data_error_result(message="Dialog not found!")
        conv = conv.to_dict()
        conv["avatar"] = conv["icon"]
        del conv["icon"]
        return get_json_result(data=conv)
    except Exception as e:
        return server_error_response(e)


@manager.route("/rm", methods=["POST"])  # noqa: F821
@login_required
async def rm():
    req = await get_request_json()
    conv_ids = req["conversation_ids"]
    try:
        for cid in conv_ids:
            exist, conv = ConversationService.get_by_id(cid)
            if not exist:
                return get_data_error_result(message="Conversation not found!")
            tenants = UserTenantService.query(user_id=current_user.id)
            for tenant in tenants:
                if DialogService.query(tenant_id=tenant.tenant_id, id=conv.dialog_id):
                    break
            else:
                return get_json_result(data=False, message="Only owner of conversation authorized for this operation.", code=RetCode.OPERATING_ERROR)
            ConversationService.delete_by_id(cid)
        return get_json_result(data=True)
    except Exception as e:
        return server_error_response(e)


@manager.route("/list", methods=["GET"])  # noqa: F821
@login_required
async def list_conversation():
    dialog_id = request.args["dialog_id"]
    try:
        if not DialogService.query(tenant_id=current_user.id, id=dialog_id):
            return get_json_result(data=False, message="Only owner of dialog authorized for this operation.", code=RetCode.OPERATING_ERROR)
        model = ConversationService.model
        convs = (
            model.select(
                model.id,
                model.dialog_id,
                model.name,
                model.user_id,
                model.create_time,
                model.create_date,
                model.update_time,
                model.update_date,
            )
            .where(model.dialog_id == dialog_id)
            .order_by(model.create_time.desc())
        )

        convs = list(convs.dicts())
        return get_json_result(data=convs)
    except Exception as e:
        return server_error_response(e)


@manager.route("/completion", methods=["POST"])  # noqa: F821
@login_required
@validate_request("conversation_id", "messages")
async def completion():
    req = await get_request_json()
    request_messages = _sanitize_conversation_messages(
        req["messages"],
        _CONVERSATION_STORAGE_MESSAGE_DROP_FIELDS,
    )
    msg = []
    for m in request_messages:
        if m["role"] == "system":
            continue
        if m["role"] == "assistant" and not msg:
            continue
        msg.append(m)
    message_id = msg[-1].get("id")
    chat_model_id = req.get("llm_id", "")
    defer_tts = bool(req.get("live_tts"))
    req.pop("llm_id", None)

    chat_model_config = {}
    for model_config in [
        "temperature",
        "top_p",
        "frequency_penalty",
        "presence_penalty",
        "max_tokens",
    ]:
        config = req.get(model_config)
        if config:
            chat_model_config[model_config] = config

    try:
        e, conv = ConversationService.get_by_id(req["conversation_id"])
        if not e:
            return get_data_error_result(message="Conversation not found!")
        conv.message = deepcopy(request_messages)
        e, dia = DialogService.get_by_id(conv.dialog_id)
        if not e:
            return get_data_error_result(message="Dialog not found!")
        model_tenant_id = UserTenantService.get_tenant_id_by_user_id(current_user.id)
        del req["conversation_id"]
        del req["messages"]
        stream_enabled = bool(req.pop("stream", True))

        if not conv.reference:
            conv.reference = []
        conv.reference = [r for r in conv.reference if r]
        conv.reference.append({"chunks": [], "doc_aggs": []})

        if chat_model_id:
            if not TenantLLMService.get_api_key(tenant_id=model_tenant_id, model_name=chat_model_id):
                req.pop("chat_model_id", None)
                req.pop("chat_model_config", None)
                return get_data_error_result(message=f"Cannot use specified model {chat_model_id}.")
            dia.llm_id = chat_model_id
            dia.llm_setting = chat_model_config

        is_embedded = bool(chat_model_id)
        user_id = current_user.id
        use_live_single_tts = bool(
            stream_enabled
            and defer_tts
            and dia.prompt_config.get("tts")
            and message_id
            and not is_embedded
        )

        if use_live_single_tts:
            assistant_placeholder = {
                "role": "assistant",
                "content": "",
                "created_at": time.time(),
                "id": message_id,
                "voice": {
                    "kind": "single",
                    "status": "streaming",
                    "mime_type": "audio/mpeg",
                },
            }
            if not conv.message or conv.message[-1].get("role") != "assistant":
                conv.message.append(assistant_placeholder)
            else:
                conv.message[-1] = assistant_placeholder
            ConversationService.update_by_id(
                conv.id,
                {
                    "message": conv.message,
                    "reference": conv.reference,
                },
            )

        async def stream():
            nonlocal dia, msg, req, conv, model_tenant_id

            def _serialize_sse(payload, code: int = 0, message: str = ""):
                return "data:" + json.dumps(
                    {"code": code, "message": message, "data": payload},
                    ensure_ascii=False,
                ) + "\n\n"

            if not use_live_single_tts:
                try:
                    async for ans in async_chat(dia, msg, True, model_tenant_id=model_tenant_id, **req):
                        ans = structure_answer(conv, ans, message_id, conv.id)
                        yield _serialize_sse(ans)
                    if not is_embedded:
                        _merge_latest_voice_state(conv)
                        _finalize_live_tts_segments(conv, message_id)
                        should_enqueue_tts = False
                        if defer_tts and dia.prompt_config.get("tts") and message_id:
                            try:
                                should_enqueue_tts = bool(
                                    VoiceChatService.prepare_assistant_tts_message(conv, message_id)
                                )
                            except Exception as e:
                                logging.warning("Prepare assistant async TTS failed: %s", e)
                        ConversationService.update_by_id(conv.id, conv.to_dict())
                        if should_enqueue_tts:
                            VoiceChatService.enqueue_assistant_tts_task(
                                user_id=user_id,
                                conversation_id=conv.id,
                                message_id=message_id,
                            )
                except Exception as e:
                    logging.exception(e)
                    yield _serialize_sse(
                        {
                            "answer": "**ERROR**: " + str(e),
                            "reference": [],
                        },
                        code=500,
                        message=str(e),
                    )
                yield _serialize_sse(True)
                return

            try:
                full_answer = await _collect_full_chat_answer(
                    dia,
                    msg,
                    model_tenant_id=model_tenant_id,
                    **{
                        **req,
                        "live_tts": False,
                        "enable_tts": False,
                    },
                )
                structured = structure_answer(conv, full_answer, message_id, conv.id)
            except Exception as e:
                logging.exception(e)
                yield _serialize_sse(
                    {
                        "answer": "**ERROR**: " + str(e),
                        "reference": [],
                    },
                    code=500,
                    message=str(e),
                )
                yield _serialize_sse(True)
                return

            latest_voice_message = None
            try:
                cleaned_text = ""
                if dia.prompt_config.get("tts") and message_id:
                    cleaned_text = VoiceChatService.prepare_assistant_tts_message(
                        conv,
                        message_id,
                        structured.get("answer") or "",
                    )
                ConversationService.update_by_id(
                    conv.id,
                    {
                        "message": conv.message,
                        "reference": conv.reference,
                    },
                )

                if cleaned_text:
                    VoiceChatService.enqueue_assistant_tts_task(
                        user_id=user_id,
                        conversation_id=conv.id,
                        message_id=message_id,
                    )
                    latest_voice_message = await asyncio.to_thread(
                        VoiceChatService.wait_for_assistant_tts_message,
                        user_id=user_id,
                        conversation_id=conv.id,
                        message_id=message_id,
                        timeout=180.0,
                    )
                else:
                    latest_voice_message = await asyncio.to_thread(
                        VoiceChatService.get_assistant_message,
                        user_id=user_id,
                        conversation_id=conv.id,
                        message_id=message_id,
                    )
            except Exception:
                logging.exception(
                    "Live single TTS failed for %s/%s",
                    conv.id,
                    message_id,
                )
                try:
                    latest_voice_message = await asyncio.to_thread(
                        VoiceChatService.get_assistant_message,
                        user_id=user_id,
                        conversation_id=conv.id,
                        message_id=message_id,
                    )
                except Exception:
                    latest_voice_message = None
            finally:
                _merge_latest_voice_state(conv)
                ConversationService.update_by_id(conv.id, conv.to_dict())

            async for payload in _yield_pseudo_stream_answers(
                structured_answer=structured,
                voice_message=latest_voice_message,
            ):
                yield _serialize_sse(payload)

            yield _serialize_sse(True)

        if stream_enabled:
            resp = Response(stream(), mimetype="text/event-stream")
            resp.headers.add_header("Cache-control", "no-cache")
            resp.headers.add_header("Connection", "keep-alive")
            resp.headers.add_header("X-Accel-Buffering", "no")
            resp.headers.add_header("Content-Type", "text/event-stream; charset=utf-8")
            return resp

        else:
            answer = None
            async for ans in async_chat(dia, msg, model_tenant_id=model_tenant_id, **req):
                answer = structure_answer(conv, ans, message_id, conv.id)
                if not is_embedded:
                    should_enqueue_tts = False
                    if defer_tts and dia.prompt_config.get("tts") and message_id:
                        try:
                            should_enqueue_tts = bool(
                                VoiceChatService.prepare_assistant_tts_message(conv, message_id)
                            )
                        except Exception as e:
                            logging.warning("Prepare assistant async TTS failed: %s", e)
                    ConversationService.update_by_id(conv.id, conv.to_dict())
                    if should_enqueue_tts:
                        VoiceChatService.enqueue_assistant_tts_task(
                            user_id=user_id,
                            conversation_id=conv.id,
                            message_id=message_id,
                        )
                break
            return get_json_result(data=answer)
    except Exception as e:
        return server_error_response(e)

@manager.route("/sequence2txt", methods=["POST"])  # noqa: F821
@login_required
async def sequence2txt():
    req = await request.form
    stream_mode = req.get("stream", "false").lower() == "true"
    files = await request.files
    if "file" not in files:
        return get_data_error_result(message="Missing 'file' in multipart form-data")

    uploaded = files["file"]

    ALLOWED_EXTS = {
        ".wav", ".mp3", ".m4a", ".aac",
        ".flac", ".ogg", ".webm",
        ".opus", ".wma"
    }

    filename = uploaded.filename or ""
    suffix = os.path.splitext(filename)[-1].lower()
    if suffix not in ALLOWED_EXTS:
        return get_data_error_result(message=
            f"Unsupported audio format: {suffix}. "
            f"Allowed: {', '.join(sorted(ALLOWED_EXTS))}"
        )
    fd, temp_audio_path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    await uploaded.save(temp_audio_path)

    tenants = TenantService.get_info_by(current_user.id)
    if not tenants:
        return get_data_error_result(message="Tenant not found!")

    asr_id = tenants[0]["asr_id"]
    if not asr_id:
        return get_data_error_result(message="No default ASR model is set")

    asr_mdl=LLMBundle(tenants[0]["tenant_id"], LLMType.SPEECH2TEXT, asr_id)
    if not stream_mode:
        text = asr_mdl.transcription(temp_audio_path)
        try:
            os.remove(temp_audio_path)
        except Exception as e:
            logging.error(f"Failed to remove temp audio file: {str(e)}")
        return get_json_result(data={"text": text})
    async def event_stream():
        try:
            for evt in asr_mdl.stream_transcription(temp_audio_path):
                yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
        except Exception as e:
            err = {"event": "error", "text": str(e)}
            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"
        finally:
            try:
                os.remove(temp_audio_path)
            except Exception as e:
                logging.error(f"Failed to remove temp audio file: {str(e)}")

    return Response(event_stream(), content_type="text/event-stream")

@manager.route("/tts", methods=["POST"])  # noqa: F821
@login_required
async def tts():
    req = await get_request_json()
    user_id = current_user.id
    text = clean_tts_text(req["text"])
    if not text:
        return get_data_error_result(message="No readable Chinese content found for TTS")
    conversation_id = (req.get("conversation_id") or "").strip()
    message_id = (req.get("message_id") or "").strip()
    seq_raw = req.get("seq")
    final_segment = bool(req.get("final"))
    persist_segment = bool(conversation_id and message_id and seq_raw is not None)
    seq = None
    if persist_segment:
        try:
            seq = int(seq_raw)
        except Exception:
            persist_segment = False

    tenants = TenantService.get_info_by(current_user.id)
    if not tenants:
        return get_data_error_result(message="Tenant not found!")

    try:
        tts_mdl = LLMBundle(tenants[0]["tenant_id"], LLMType.TTS)
    except Exception as e:
        logging.warning("Live TTS model init failed: %s", e)
        return get_data_error_result(message="TTS service is not configured")

    mime_type = getattr(getattr(tts_mdl, "mdl", None), "last_mime_type", "audio/mpeg")
    mime_type = (mime_type or "audio/mpeg").split(";", 1)[0].strip() or "audio/mpeg"

    def stream_audio():
        completed = False
        audio = bytearray()
        for chunk in tts_mdl.tts(text):
            if persist_segment and isinstance(chunk, (bytes, bytearray)):
                audio.extend(chunk)
            yield chunk
        completed = True

        if persist_segment and completed and audio:
            try:
                VoiceChatService.persist_assistant_tts_segment(
                    user_id=user_id,
                    conversation_id=conversation_id,
                    message_id=message_id,
                    seq=seq,
                    text=text,
                    audio=bytes(audio),
                    mime_type=mime_type,
                    final=final_segment,
                )
            except Exception as e:
                logging.warning("Persist live TTS segment failed: %s", e)

    resp = Response(stream_audio(), mimetype=mime_type)
    resp.headers.add_header("Cache-Control", "no-cache")
    resp.headers.add_header("Connection", "keep-alive")
    resp.headers.add_header("X-Accel-Buffering", "no")

    return resp


@manager.route("/voice_completion", methods=["POST"])  # noqa: F821
@login_required
async def voice_completion():
    form = await request.form
    files = await request.files
    user_id = current_user.id

    conversation_id = form.get("conversation_id", "").strip()
    client_message_id = form.get("client_message_id", "").strip()
    duration_raw = form.get("duration_ms", "0")
    mime_type = form.get("mime_type", "").strip() or "audio/webm"
    waveform_raw = form.get("waveform", "")
    uploaded = files.get("file")

    if not conversation_id:
        return get_data_error_result(message="conversation_id is required")
    if not client_message_id:
        return get_data_error_result(message="client_message_id is required")
    if not uploaded:
        return get_data_error_result(message="Missing 'file' in multipart form-data")

    try:
        duration_ms = int(duration_raw)
    except Exception:
        duration_ms = 0

    try:
        waveform = json.loads(waveform_raw) if waveform_raw else []
        if not isinstance(waveform, list):
            waveform = []
    except Exception:
        waveform = []

    filename = uploaded.filename or "voice.webm"
    audio_bytes = uploaded.read()

    async def stream():
        try:
            async for event in VoiceChatService.stream_voice_completion(
                user_id=user_id,
                conversation_id=conversation_id,
                client_message_id=client_message_id,
                filename=filename,
                mime_type=mime_type,
                duration_ms=duration_ms,
                waveform=waveform,
                audio_bytes=audio_bytes,
            ):
                yield "data:" + json.dumps(event, ensure_ascii=False) + "\n\n"
        except Exception as e:
            logging.exception(e)
            yield "data:" + json.dumps(
                {
                    "code": 500,
                    "type": "error",
                    "data": {
                        "stage": "storage",
                        "message": str(e),
                        "client_message_id": client_message_id,
                        "recoverable": False,
                    },
                },
                ensure_ascii=False,
            ) + "\n\n"
            yield "data:" + json.dumps({"code": 0, "type": "done", "data": True}, ensure_ascii=False) + "\n\n"

    resp = Response(stream(), mimetype="text/event-stream")
    resp.headers.add_header("Cache-Control", "no-cache")
    resp.headers.add_header("Connection", "keep-alive")
    resp.headers.add_header("X-Accel-Buffering", "no")
    resp.headers.add_header("Content-Type", "text/event-stream; charset=utf-8")
    return resp


@manager.route("/retry_voice_completion", methods=["POST"])  # noqa: F821
@login_required
@validate_request("conversation_id", "message_id")
async def retry_voice_completion():
    req = await get_request_json()
    user_id = current_user.id
    conversation_id = req["conversation_id"]
    message_id = req["message_id"]

    async def stream():
        try:
            async for event in VoiceChatService.stream_retry_voice_completion(
                user_id=user_id,
                conversation_id=conversation_id,
                message_id=message_id,
            ):
                yield "data:" + json.dumps(event, ensure_ascii=False) + "\n\n"
        except Exception as e:
            logging.exception(e)
            yield "data:" + json.dumps(
                {
                    "code": 500,
                    "type": "error",
                    "data": {
                        "stage": "asr",
                        "message": str(e),
                        "client_message_id": message_id,
                        "recoverable": False,
                    },
                },
                ensure_ascii=False,
            ) + "\n\n"
            yield "data:" + json.dumps({"code": 0, "type": "done", "data": True}, ensure_ascii=False) + "\n\n"

    resp = Response(stream(), mimetype="text/event-stream")
    resp.headers.add_header("Cache-Control", "no-cache")
    resp.headers.add_header("Connection", "keep-alive")
    resp.headers.add_header("X-Accel-Buffering", "no")
    resp.headers.add_header("Content-Type", "text/event-stream; charset=utf-8")
    return resp


@manager.route("/voice_file", methods=["GET"])  # noqa: F821
@login_required
async def voice_file():
    conversation_id = request.args.get("conversation_id", "")
    message_id = request.args.get("message_id", "")
    seq = request.args.get("seq")
    role = request.args.get("role")

    if not conversation_id or not message_id:
        return get_data_error_result(message="conversation_id and message_id are required")

    try:
        blob, mime_type = VoiceChatService.get_voice_blob_for_message(
            user_id=current_user.id,
            conversation_id=conversation_id,
            message_id=message_id,
            seq=int(seq) if seq is not None else None,
            role=role,
        )
        resp = Response(blob, mimetype=mime_type)
        resp.headers.add_header("Cache-Control", "no-cache")
        return resp
    except LookupError as e:
        return Response(str(e), status=404, mimetype="text/plain")
    except Exception as e:
        return server_error_response(e)


@manager.route("/wait_assistant_voice", methods=["GET"])  # noqa: F821
@login_required
async def wait_assistant_voice():
    conversation_id = request.args.get("conversation_id", "")
    message_id = request.args.get("message_id", "")
    timeout_raw = request.args.get("timeout", "90")

    if not conversation_id or not message_id:
        return get_data_error_result(message="conversation_id and message_id are required")

    try:
        timeout = float(timeout_raw)
    except Exception:
        timeout = 90.0

    timeout = max(1.0, min(timeout, 180.0))

    try:
        message = await asyncio.to_thread(
            VoiceChatService.wait_for_assistant_tts_message,
            user_id=current_user.id,
            conversation_id=conversation_id,
            message_id=message_id,
            timeout=timeout,
        )
        sanitized_message = _sanitize_conversation_message(
            message,
            _CONVERSATION_RESPONSE_MESSAGE_DROP_FIELDS,
        )
        return get_json_result(data={"message": sanitized_message})
    except LookupError as e:
        return Response(str(e), status=404, mimetype="text/plain")
    except Exception as e:
        return server_error_response(e)


@manager.route("/delete_msg", methods=["POST"])  # noqa: F821
@login_required
@validate_request("conversation_id", "message_id")
async def delete_msg():
    req = await get_request_json()
    e, conv = ConversationService.get_by_id(req["conversation_id"])
    if not e:
        return get_data_error_result(message="Conversation not found!")

    conv = conv.to_dict()
    for i, msg in enumerate(conv["message"]):
        if req["message_id"] != msg.get("id", ""):
            continue
        assert conv["message"][i + 1]["id"] == req["message_id"]
        conv["message"].pop(i)
        conv["message"].pop(i)
        conv["reference"].pop(max(0, i // 2 - 1))
        break

    ConversationService.update_by_id(conv["id"], conv)
    return get_json_result(data=conv)


@manager.route("/thumbup", methods=["POST"])  # noqa: F821
@login_required
@validate_request("conversation_id", "message_id")
async def thumbup():
    req = await get_request_json()
    e, conv = ConversationService.get_by_id(req["conversation_id"])
    if not e:
        return get_data_error_result(message="Conversation not found!")
    up_down = req.get("thumbup")
    feedback = req.get("feedback", "")
    conv = conv.to_dict()
    for i, msg in enumerate(conv["message"]):
        if req["message_id"] == msg.get("id", "") and msg.get("role", "") == "assistant":
            if up_down:
                msg["thumbup"] = True
                if "feedback" in msg:
                    del msg["feedback"]
            else:
                msg["thumbup"] = False
                if feedback:
                    msg["feedback"] = feedback
            break

    ConversationService.update_by_id(conv["id"], conv)
    return get_json_result(data=conv)


@manager.route("/ask", methods=["POST"])  # noqa: F821
@login_required
@validate_request("question", "kb_ids")
async def ask_about():
    req = await get_request_json()
    uid = current_user.id

    search_id = req.get("search_id", "")
    search_app = None
    search_config = {}
    if search_id:
        search_app = SearchService.get_detail(search_id)
    if search_app:
        search_config = search_app.get("search_config", {})

    async def stream():
        nonlocal req, uid
        try:
            async for ans in async_ask(req["question"], req["kb_ids"], uid, search_config=search_config):
                yield "data:" + json.dumps({"code": 0, "message": "", "data": ans}, ensure_ascii=False) + "\n\n"
        except Exception as e:
            yield "data:" + json.dumps({"code": 500, "message": str(e), "data": {"answer": "**ERROR**: " + str(e), "reference": []}}, ensure_ascii=False) + "\n\n"
        yield "data:" + json.dumps({"code": 0, "message": "", "data": True}, ensure_ascii=False) + "\n\n"

    resp = Response(stream(), mimetype="text/event-stream")
    resp.headers.add_header("Cache-control", "no-cache")
    resp.headers.add_header("Connection", "keep-alive")
    resp.headers.add_header("X-Accel-Buffering", "no")
    resp.headers.add_header("Content-Type", "text/event-stream; charset=utf-8")
    return resp


@manager.route("/mindmap", methods=["POST"])  # noqa: F821
@login_required
@validate_request("question", "kb_ids")
async def mindmap():
    req = await get_request_json()
    search_id = req.get("search_id", "")
    search_app = SearchService.get_detail(search_id) if search_id else {}
    search_config = search_app.get("search_config", {}) if search_app else {}
    kb_ids = search_config.get("kb_ids", [])
    kb_ids.extend(req["kb_ids"])
    kb_ids = list(set(kb_ids))

    mind_map = await gen_mindmap(req["question"], kb_ids, search_app.get("tenant_id", current_user.id), search_config)
    if "error" in mind_map:
        return server_error_response(Exception(mind_map["error"]))
    return get_json_result(data=mind_map)


@manager.route("/related_questions", methods=["POST"])  # noqa: F821
@login_required
@validate_request("question")
async def related_questions():
    req = await get_request_json()

    search_id = req.get("search_id", "")
    search_config = {}
    if search_id:
        if search_app := SearchService.get_detail(search_id):
            search_config = search_app.get("search_config", {})

    question = req["question"]

    chat_id = search_config.get("chat_id", "")
    chat_mdl = LLMBundle(current_user.id, LLMType.CHAT, chat_id)

    gen_conf = search_config.get("llm_setting", {"temperature": 0.9})
    if "parameter" in gen_conf:
        del gen_conf["parameter"]
    prompt = load_prompt("related_question")
    ans = await chat_mdl.async_chat(
        prompt,
        [
            {
                "role": "user",
                "content": f"""
Keywords: {question}
Related search terms:
    """,
            }
        ],
        gen_conf,
    )
    return get_json_result(data=[re.sub(r"^[0-9]\. ", "", a) for a in ans.split("\n") if re.match(r"^[0-9]\. ", a)])

@manager.route("/export", methods=["POST"])  # noqa: F821
@login_required
@validate_request("conversation_id", "id_card_number")
async def export_conversation():
    req = await get_request_json()
    conversation_id = req["conversation_id"]
    id_card_number = req["id_card_number"]
    export_type = req.get("export_type", "conversation")
    logging.info(f"导出会话 {conversation_id}，用户身份证号 {id_card_number}，导出类型 {export_type}")

    owned, error = _get_owned_conversation(conversation_id)
    if error:
        return error
    conv, dialog = owned

    stored_id_card = getattr(dialog, 'id_card_number', None)
    logging.info(f"身份证号验证: 输入={id_card_number}, 存储={stored_id_card}")

    if stored_id_card and stored_id_card != id_card_number:
        logging.warning(f"身份证号不匹配: 输入={id_card_number}, 存储={stored_id_card}")
        return get_data_error_result(message="身份证号不匹配")
    
    messages = conv.message or []
    
    if export_type == "table":
        markdown_content = generate_table_markdown(conv, messages)
    else:
        markdown_content = generate_markdown(messages)

    from quart import make_response
    _, disposition = build_download_filename(conv.name, ".pdf")
    pdf_bytes = await asyncio.to_thread(
        markdown_to_pdf_bytes,
        markdown_content,
        getattr(conv, "name", None) or "会话导出",
    )

    response = await make_response(pdf_bytes)
    response.headers['Content-Type'] = 'application/pdf'
    response.headers['Content-Disposition'] = disposition
    return response


@manager.route("/printers", methods=["GET"])  # noqa: F821
@login_required
async def list_printers():
    try:
        printers = await asyncio.to_thread(ConversationPrintService.list_printers)
        return get_json_result(data={"printers": printers})
    except Exception as e:
        return server_error_response(e)


@manager.route("/print", methods=["POST"])  # noqa: F821
@login_required
@validate_request("conversation_id", "printer_name")
async def print_conversation():
    req = await get_request_json()
    conversation_id = req["conversation_id"]
    export_type = req.get("export_type", "conversation")
    printer_name = req["printer_name"]
    title = req.get("title")
    copies = req.get("copies", 1)

    owned, error = _get_owned_conversation(conversation_id)
    if error:
        return error
    conv, _ = owned

    messages = conv.message or []
    if export_type == "table":
        markdown_content = generate_table_markdown(conv, messages)
    else:
        markdown_content = generate_markdown(messages)

    try:
        copies = int(copies)
    except (TypeError, ValueError):
        copies = 1

    try:
        result = await asyncio.to_thread(
            ConversationPrintService.print_markdown,
            printer_name=printer_name,
            markdown_content=markdown_content,
            title=(title or conv.name or "conversation").strip(),
            copies=max(1, min(copies, 20)),
        )
        return get_json_result(data=result)
    except Exception as e:
        return server_error_response(e)

def verify_id_card_number(id_card_number):
    """验证身份证号是否正确"""
    # 写死的身份证号，用于测试
    #TODO: 从数据库中查询用户的身份证号进行验证
    valid_id_card_number = "110101199003074567"
    return id_card_number == valid_id_card_number


def verify_birthday_match(id_card_number, birthday_input):
    """
    校验用户输入的生日与身份证号中的生日是否一致
    
    Args:
        id_card_number: 中国身份证号（18位）
        birthday_input: 用户输入的生日字符串，必须为 YYYYMMDD 格式
    
    Returns:
        bool: 生日是否匹配
    """
    if not id_card_number or len(id_card_number) < 14:
        return False
    
    if not birthday_input:
        return False
    
    if not validate_birthday_format(birthday_input):
        logging.warning(f"Invalid birthday format: {birthday_input}")
        return False
    
    birthday_from_id = extract_birthday_from_id(id_card_number)
    if not birthday_from_id:
        return False
    
    logging.debug(f"Birthday from ID: {birthday_from_id}, Input: {birthday_input}")
    
    return birthday_from_id == birthday_input


def validate_birthday_format(birthday_input):
    """
    校验生日格式是否为 YYYYMMDD
    
    Args:
        birthday_input: 用户输入的生日字符串
    
    Returns:
        bool: 格式是否正确
    """
    if not birthday_input:
        return False
    
    birthday_input = str(birthday_input).strip()
    
    if not re.match(r'^\d{8}$', birthday_input):
        return False
    return True



def extract_birthday_from_id(social_security_number):
    """
    从中国身份证号中提取生日
    
    身份证号第7-14位为出生日期，格式为YYYYMMDD
    
    Args:
        social_security_number: 18位中国身份证号
    
    Returns:
        str: 标准化的生日字符串 "YYYYMMDD"，提取失败返回 None
    """
    if not social_security_number or len(social_security_number) < 14:
        return None
    
    try:
        birth_part = social_security_number[6:14]
        if not birth_part.isdigit():
            return None
        
        year = birth_part[0:4]
        month = birth_part[4:6]
        day = birth_part[6:8]
        
        if not (1 <= int(month) <= 12 and 1 <= int(day) <= 31):
            return None
        
        return f"{year}{month}{day}"
    except (ValueError, IndexError):
        return None
