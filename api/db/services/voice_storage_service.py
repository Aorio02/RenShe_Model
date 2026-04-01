import os

from api.db.services.file_service import FileService


class VoiceStorageService:
    USER_AUDIO_PREFIX = "voice"

    @staticmethod
    def _guess_extension(filename: str | None, mime_type: str | None, default: str) -> str:
        if filename and "." in filename:
            ext = os.path.splitext(filename)[1].lower()
            if ext:
                return ext
        if mime_type:
            ext_map = {
                "audio/webm": ".webm",
                "audio/mpeg": ".mp3",
                "audio/mp3": ".mp3",
                "audio/wav": ".wav",
                "audio/x-wav": ".wav",
                "audio/ogg": ".ogg",
                "audio/mp4": ".m4a",
                "audio/aac": ".aac",
                "audio/flac": ".flac",
            }
            if mime_type in ext_map:
                return ext_map[mime_type]
        return default

    @classmethod
    def build_user_voice_key(
        cls,
        conversation_id: str,
        message_id: str,
        filename: str | None,
        mime_type: str | None,
    ) -> str:
        ext = cls._guess_extension(filename, mime_type, ".webm")
        return f"{cls.USER_AUDIO_PREFIX}/{conversation_id}/{message_id}/user{ext}"

    @classmethod
    def build_assistant_segment_key(
        cls,
        conversation_id: str,
        message_id: str,
        seq: int,
        mime_type: str | None = None,
    ) -> str:
        ext = cls._guess_extension(None, mime_type, ".mp3")
        return f"{cls.USER_AUDIO_PREFIX}/{conversation_id}/{message_id}/assistant/{seq:03d}{ext}"

    @classmethod
    def build_assistant_final_key(
        cls,
        conversation_id: str,
        message_id: str,
        mime_type: str | None = None,
    ) -> str:
        ext = cls._guess_extension(None, mime_type, ".mp3")
        return f"{cls.USER_AUDIO_PREFIX}/{conversation_id}/{message_id}/assistant/final{ext}"

    @staticmethod
    def save_blob(user_id: str, location: str, blob: bytes) -> str:
        FileService.put_blob(user_id, location, blob)
        return location

    @staticmethod
    def get_blob(user_id: str, location: str) -> bytes:
        return FileService.get_blob(user_id, location)
