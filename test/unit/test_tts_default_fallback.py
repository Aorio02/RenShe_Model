import importlib.util
import sys
import types
from enum import Enum
from pathlib import Path
from types import SimpleNamespace


def _load_tenant_llm_service_module():
    module_path = Path(__file__).resolve().parents[2] / "api" / "db" / "services" / "tenant_llm_service.py"

    fake_settings = SimpleNamespace(
        TTS_MDL="",
        TTS_CFG={},
        FACTORY_LLM_INFOS=[{"name": "OpenAI-API-Compatible"}],
    )

    common_module = types.ModuleType("common")
    common_module.settings = fake_settings
    sys.modules["common"] = common_module

    class LLMType(str, Enum):
        EMBEDDING = "embedding"
        SPEECH2TEXT = "speech2text"
        IMAGE2TEXT = "image2text"
        CHAT = "chat"
        RERANK = "rerank"
        TTS = "tts"
        OCR = "ocr"

    constants_module = types.ModuleType("common.constants")
    constants_module.MINERU_DEFAULT_CONFIG = {}
    constants_module.MINERU_ENV_KEYS = []
    constants_module.PADDLEOCR_DEFAULT_CONFIG = {}
    constants_module.PADDLEOCR_ENV_KEYS = []
    constants_module.LLMType = LLMType
    sys.modules["common.constants"] = constants_module

    peewee_module = types.ModuleType("peewee")
    peewee_module.IntegrityError = Exception
    sys.modules["peewee"] = peewee_module

    langfuse_module = types.ModuleType("langfuse")
    langfuse_module.Langfuse = object
    sys.modules["langfuse"] = langfuse_module

    class DummyDB:
        @staticmethod
        def connection_context():
            def decorator(func):
                return func

            return decorator

    db_models_module = types.ModuleType("api.db.db_models")
    db_models_module.DB = DummyDB()
    db_models_module.LLMFactories = object
    db_models_module.TenantLLM = object
    sys.modules["api.db.db_models"] = db_models_module

    common_service_module = types.ModuleType("api.db.services.common_service")

    class CommonService:
        pass

    common_service_module.CommonService = CommonService
    sys.modules["api.db.services.common_service"] = common_service_module

    langfuse_service_module = types.ModuleType("api.db.services.langfuse_service")
    langfuse_service_module.TenantLangfuseService = object
    sys.modules["api.db.services.langfuse_service"] = langfuse_service_module

    user_service_module = types.ModuleType("api.db.services.user_service")

    class TenantService:
        pass

    user_service_module.TenantService = TenantService
    sys.modules["api.db.services.user_service"] = user_service_module

    rag_llm_module = types.ModuleType("rag.llm")
    rag_llm_module.ChatModel = {}
    rag_llm_module.CvModel = {}
    rag_llm_module.EmbeddingModel = {}
    rag_llm_module.OcrModel = {}
    rag_llm_module.RerankModel = {}
    rag_llm_module.Seq2txtModel = {}
    rag_llm_module.TTSModel = {}
    sys.modules["rag.llm"] = rag_llm_module

    spec = importlib.util.spec_from_file_location("test_tenant_llm_service_module", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module, fake_settings


_MODULE, _SETTINGS = _load_tenant_llm_service_module()
TenantLLMService = _MODULE.TenantLLMService


def test_get_system_tts_model_config_uses_platform_default():
    _SETTINGS.TTS_MDL = "BUPT-TTS___OpenAI-API@OpenAI-API-Compatible"
    _SETTINGS.TTS_CFG = {
        "factory": "OpenAI-API-Compatible",
        "api_key": "x",
        "base_url": "http://127.0.0.1:8010/v1",
    }

    model_config = TenantLLMService.get_system_tts_model_config()

    assert model_config == {
        "llm_factory": "OpenAI-API-Compatible",
        "api_key": "x",
        "llm_name": "BUPT-TTS___OpenAI-API",
        "api_base": "http://127.0.0.1:8010/v1",
    }


def test_resolve_default_tts_model_name_falls_back_to_platform_default(monkeypatch):
    tenant = SimpleNamespace(tts_id="")
    _SETTINGS.TTS_MDL = "BUPT-TTS___OpenAI-API@OpenAI-API-Compatible"

    monkeypatch.setattr(TenantLLMService, "get_api_key", classmethod(lambda cls, tenant_id, model_name: None))

    model_name = TenantLLMService.resolve_default_tts_model_name("tenant-1", tenant)

    assert model_name == "BUPT-TTS___OpenAI-API@OpenAI-API-Compatible"


def test_resolve_default_tts_model_name_keeps_authorized_tenant_model(monkeypatch):
    tenant = SimpleNamespace(tts_id="tenant-custom@OpenAI-API-Compatible")
    _SETTINGS.TTS_MDL = "BUPT-TTS___OpenAI-API@OpenAI-API-Compatible"

    monkeypatch.setattr(
        TenantLLMService,
        "get_api_key",
        classmethod(lambda cls, tenant_id, model_name: object() if model_name == tenant.tts_id else None),
    )

    model_name = TenantLLMService.resolve_default_tts_model_name("tenant-1", tenant)

    assert model_name == "tenant-custom@OpenAI-API-Compatible"
