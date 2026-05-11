from __future__ import annotations

from pathlib import Path


_AUDIO_EXTENSION_MAP = {
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


def normalize_audio_mime_type(mime_type: str | None, default: str = "audio/webm") -> str:
    if not mime_type:
        return default
    return mime_type.split(";", 1)[0].strip().lower() or default


def detect_audio_mime_type(blob: bytes | bytearray | memoryview | None) -> str | None:
    if not blob:
        return None

    header = bytes(blob[:32])
    if len(header) >= 12 and header[:4] == b"RIFF" and header[8:12] == b"WAVE":
        return "audio/wav"
    if header.startswith(b"fLaC"):
        return "audio/flac"
    if header.startswith(b"OggS"):
        return "audio/ogg"
    if header.startswith(b"\x1A\x45\xDF\xA3"):
        return "audio/webm"
    if len(header) >= 8 and header[4:8] == b"ftyp":
        return "audio/mp4"
    if header.startswith(b"ID3"):
        return "audio/mpeg"
    if len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xF6) == 0xF0:
        return "audio/aac"
    if len(header) >= 2 and header[0] == 0xFF and (header[1] & 0xE0) == 0xE0:
        return "audio/mpeg"
    return None


def resolve_audio_mime_type(
    blob: bytes | bytearray | memoryview | None,
    mime_type: str | None,
    default: str = "audio/webm",
) -> str:
    detected_mime_type = detect_audio_mime_type(blob)
    if detected_mime_type:
        return detected_mime_type
    return normalize_audio_mime_type(mime_type, default)


def guess_audio_extension(
    filename: str | None,
    mime_type: str | None,
    default: str,
    blob: bytes | bytearray | memoryview | None = None,
) -> str:
    normalized_mime_type = (
        resolve_audio_mime_type(blob, mime_type, default="")
        if blob is not None
        else normalize_audio_mime_type(mime_type, default="")
    )
    if normalized_mime_type and normalized_mime_type in _AUDIO_EXTENSION_MAP:
        return _AUDIO_EXTENSION_MAP[normalized_mime_type]
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[-1].strip().lower()
        if ext:
            return f".{ext}"
    return default


def build_audio_filename(
    filename: str | None,
    mime_type: str | None,
    default_stem: str = "voice",
    blob: bytes | bytearray | memoryview | None = None,
) -> str:
    stem = Path(filename or "").stem.strip() or default_stem
    ext = guess_audio_extension(filename, mime_type, ".webm", blob)
    return f"{stem}{ext}"
