import re
from quart import request
from api.utils.api_utils import server_error_response, get_data_error_result
import requests

@manager.route('/audio_to_text', methods=['POST'])
async def audio_to_text():
    try:
        files = await request.files
        if 'file' not in files:
            return get_data_error_result(message="No file part")
        
        file = files['file']
        if file.filename == '':
            return get_data_error_result(message="No selected file")

        # 2. 读取文件内容
        audio_binary = file.read()

        # 3. 调用宿主机 ASR 服务
        asr_url = "http://172.17.0.1:6006/asr"
        asr_res = requests.post(
            asr_url, 
            files={'file': (file.filename, audio_binary, file.content_type)}
        )

        if asr_res.status_code != 200:
            return server_error_response(RuntimeError("ASR Service Error"))

        # 4. 获取原始文本
        raw_text = asr_res.json().get("text", "")

        # 5. 【正则过滤】去掉所有 <|...|> 格式的标签
        clean_text = re.sub(r'<\|.*?\|>', '', raw_text).strip()

        # 6. 返回结果
        # 返回字典时，Quart 会自动处理 JSON 序列化
        return {
            "code": 200,
            "data": clean_text,
            "message": "success"
        }

    except Exception as e:
        return server_error_response(e)