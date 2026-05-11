from api.apps import app
from api.utils.api_utils import get_data_error_result, get_json_result


def test_get_data_error_result_keeps_chinese_readable():
    with app.app_context():
        response = get_data_error_result(message="身份证号不匹配")
        body = response.get_data(as_text=True)
        assert "身份证号不匹配" in body
        assert "\\u8eab\\u4efd\\u8bc1\\u53f7\\u4e0d\\u5339\\u914d" not in body


def test_get_json_result_keeps_chinese_readable():
    with app.app_context():
        response = get_json_result(message="导出失败", data={"detail": "中文"})
        body = response.get_data(as_text=True)
        assert "导出失败" in body
        assert "中文" in body
