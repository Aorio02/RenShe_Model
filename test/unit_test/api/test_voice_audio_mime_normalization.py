from api.utils.audio_utils import (
    build_audio_filename,
    detect_audio_mime_type,
    guess_audio_extension,
    normalize_audio_mime_type,
    resolve_audio_mime_type,
)


def test_normalize_audio_mime_type_strips_codec_suffix():
    assert normalize_audio_mime_type("audio/webm;codecs=opus") == "audio/webm"


def test_guess_audio_extension_handles_codec_suffix():
    assert guess_audio_extension(None, "audio/webm;codecs=opus", ".webm") == ".webm"


def test_detect_audio_mime_type_from_wav_header():
    wav_bytes = b"RIFF\x24\x80\x00\x00WAVEfmt "
    assert detect_audio_mime_type(wav_bytes) == "audio/wav"


def test_resolve_audio_mime_type_prefers_blob_signature():
    mp4_bytes = b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A isom"
    assert resolve_audio_mime_type(mp4_bytes, "audio/webm") == "audio/mp4"


def test_guess_audio_extension_prefers_detected_blob_signature():
    mp4_bytes = b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A isom"
    assert (
        guess_audio_extension("voice-message.webm", "audio/webm", ".webm", mp4_bytes)
        == ".m4a"
    )


def test_build_audio_filename_rewrites_mismatched_extension():
    mp4_bytes = b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A isom"
    assert (
        build_audio_filename("voice-message.webm", "audio/webm", blob=mp4_bytes)
        == "voice-message.m4a"
    )
