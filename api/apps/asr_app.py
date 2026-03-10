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
"""
Fun-ASR 语音转文字独立接口
不依赖 ragflow 的 LLM 配置系统，直接使用 Fun-ASR 模型
"""

import json
import os
import logging
import tempfile
import asyncio
from pathlib import Path
from typing import Optional, Dict, Any

from quart import request, Blueprint
from api.apps import login_required, current_user
from api.utils.api_utils import get_data_error_result, get_json_result, server_error_response

# 创建 Blueprint
manager = Blueprint("asr", __name__)

# Fun-ASR 模型管理器（单例模式）
class FunASRManager:
    """Fun-ASR 模型管理器 - 单例模式"""
    _instance = None
    _model = None
    _lock = asyncio.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance
    
    async def get_model(self):
        """获取或初始化模型"""
        if self._model is None:
            async with self._lock:
                if self._model is None:
                    try:
                        import torch
                        from funasr import AutoModel
                        
                        # 自动检测设备
                        device = (
                            "cuda:0"
                            if torch.cuda.is_available()
                            else "mps"
                            if torch.backends.mps.is_available()
                            else "cpu"
                        )
                        
                        logging.info(f"Initializing Fun-ASR model on device: {device}")
                        
                        model_dir = os.environ.get(
                            "FUNASR_MODEL_DIR", 
                            "FunAudioLLM/Fun-ASR-Nano-2512"
                        )
                        
                        # 检查本地模型路径
                        local_model_path = Path("/home/rsuser/RenShe_Model/Fun-ASR")
                        if local_model_path.exists():
                            # 使用本地模型
                            model_dir = str(local_model_path)
                            logging.info(f"Using local Fun-ASR model: {model_dir}")
                        
                        self._model = AutoModel(
                            model=model_dir,
                            trust_remote_code=True,
                            remote_code="./model.py" if os.path.exists("./model.py") else None,
                            device=device,
                            hub="ms",  # ModelScope
                            vad_model="fsmn-vad",
                            vad_kwargs={"max_single_segment_time": 30000},
                        )
                        
                        logging.info("Fun-ASR model initialized successfully")
                        
                    except Exception as e:
                        logging.error(f"Failed to initialize Fun-ASR model: {e}")
                        raise RuntimeError(f"Fun-ASR model initialization failed: {e}")
        
        return self._model
    
    async def transcribe(self, audio_path: str, language: str = "中文", hotwords: list = None) -> Dict[str, Any]:
        """执行语音识别"""
        model = await self.get_model()
        
        try:
            res = model.generate(
                input=[audio_path],
                cache={},
                batch_size=1,
                hotwords=hotwords or [],
                language=language,
                itn=True,
            )
            
            text = res[0]["text"] if res and len(res) > 0 else ""
            
            return {
                "success": True,
                "text": text,
                "language": language,
            }
            
        except Exception as e:
            logging.error(f"Transcription error: {e}")
            return {
                "success": False,
                "error": str(e),
                "text": "",
            }


# 全局模型管理器实例
asr_manager = FunASRManager()


@manager.route("/transcribe", methods=["POST"])  # noqa: F821
@login_required
async def transcribe_audio():
    """
    语音转文字接口
    支持音频文件上传，返回识别文本
    
    Request:
        - file: 音频文件 (multipart/form-data)
        - language: 语言 (可选, 默认: 中文)
        - hotwords: 热词列表 (可选, JSON格式)
    
    Response:
        {
            "code": 0,
            "data": {
                "text": "识别结果",
                "language": "中文"
            }
        }
    """
    try:
        # 获取上传的文件
        files = await request.files
        if "file" not in files:
            return get_data_error_result(message="Missing 'file' in multipart form-data")
        
        uploaded = files["file"]
        
        # 支持的音频格式
        ALLOWED_EXTS = {
            ".wav", ".mp3", ".m4a", ".aac",
            ".flac", ".ogg", ".webm", ".opus", ".wma"
        }
        
        filename = uploaded.filename or ""
        suffix = os.path.splitext(filename)[-1].lower()
        
        if suffix not in ALLOWED_EXTS:
            return get_data_error_result(
                message=f"Unsupported audio format: {suffix}. "
                f"Allowed: {', '.join(sorted(ALLOWED_EXTS))}"
            )
        
        # 保存临时文件
        fd, temp_audio_path = tempfile.mkstemp(suffix=suffix)
        os.close(fd)
        
        try:
            await uploaded.save(temp_audio_path)
            logging.info(f"Saved audio file: {temp_audio_path}")
            
            # 获取参数
            form = await request.form
            language = form.get("language", "中文")
            hotwords_str = form.get("hotwords", "[]")
            
            try:
                hotwords = json.loads(hotwords_str) if hotwords_str else []
            except json.JSONDecodeError:
                hotwords = []
            
            # 执行识别
            result = await asr_manager.transcribe(
                temp_audio_path,
                language=language,
                hotwords=hotwords
            )
            
            if result["success"]:
                return get_json_result(data={
                    "text": result["text"],
                    "language": result["language"],
                })
            else:
                return get_data_error_result(message=f"Transcription failed: {result['error']}")
                
        finally:
            # 清理临时文件
            try:
                os.remove(temp_audio_path)
            except Exception as e:
                logging.warning(f"Failed to remove temp file: {e}")
                
    except Exception as e:
        logging.exception("Transcription endpoint error")
        return server_error_response(e)


@manager.route("/transcribe/stream", methods=["POST"])  # noqa: F821
@login_required
async def transcribe_audio_stream():
    """
    流式语音转文字接口（预留）
    未来支持实时流式识别
    """
    return get_data_error_result(message="Stream transcription not implemented yet")


@manager.route("/status", methods=["GET"])  # noqa: F821
async def asr_status():
    """
    检查 ASR 服务状态
    """
    try:
        # 尝试初始化模型
        model = await asr_manager.get_model()
        
        return get_json_result(data={
            "status": "ready",
            "model": "Fun-ASR-Nano-2512",
            "message": "ASR service is ready"
        })
        
    except Exception as e:
        return get_json_result(data={
            "status": "not_ready",
            "error": str(e),
            "message": "ASR service is not ready. Please check Fun-ASR installation."
        })


@manager.route("/languages", methods=["GET"])  # noqa: F821
async def list_languages():
    """
    获取支持的语言列表
    """
    languages = [
        {"code": "中文", "name": "Chinese", "name_zh": "中文"},
        {"code": "英文", "name": "English", "name_zh": "英文"},
        {"code": "日文", "name": "Japanese", "name_zh": "日文"},
    ]
    
    return get_json_result(data=languages)