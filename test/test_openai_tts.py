import importlib.util
from pathlib import Path


_MODULE_PATH = Path(__file__).resolve().parents[1] / "rag" / "llm" / "tts_model.py"
_SPEC = importlib.util.spec_from_file_location("test_openai_tts_model", _MODULE_PATH)
_MODULE = importlib.util.module_from_spec(_SPEC)
assert _SPEC and _SPEC.loader
_SPEC.loader.exec_module(_MODULE)

OpenAITTS = _MODULE.OpenAITTS


class DummyResponse:
    def __init__(self, status_code, text="", headers=None, chunks=None):
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}
        self._chunks = chunks or []

    def iter_content(self):
        yield from self._chunks

    def close(self):
        pass


def test_openai_tts_retries_without_voice(monkeypatch):
    calls = []
    responses = iter(
        [
            DummyResponse(500, "Internal Server Error", {"Content-Type": "text/plain"}),
            DummyResponse(200, headers={"Content-Type": "audio/wav"}, chunks=[b"abc"]),
        ]
    )

    def fake_post(url, headers, json, stream):
        calls.append({"url": url, "headers": headers, "json": json, "stream": stream})
        return next(responses)

    monkeypatch.setattr(_MODULE.requests, "post", fake_post)

    mdl = OpenAITTS("x", "qwen3-tts-local", "http://127.0.0.1:8010/v1")
    assert list(mdl.tts("hello")) == [b"abc"]
    assert mdl.last_mime_type == "audio/wav"
    assert len(calls) == 2
    assert calls[0]["json"]["voice"] == "alloy"
    assert "voice" not in calls[1]["json"]


def test_openai_tts_raises_runtime_error_after_retry(monkeypatch):
    responses = iter(
        [
            DummyResponse(500, "first failure", {"Content-Type": "text/plain"}),
            DummyResponse(400, "second failure", {"Content-Type": "application/json"}),
        ]
    )

    def fake_post(url, headers, json, stream):
        return next(responses)

    monkeypatch.setattr(_MODULE.requests, "post", fake_post)

    mdl = OpenAITTS("x", "qwen3-tts-local", "http://127.0.0.1:8010/v1")

    try:
        list(mdl.tts("hello"))
        assert False, "Expected RuntimeError"
    except RuntimeError as exc:
        assert str(exc) == "**ERROR**: 400, second failure"
