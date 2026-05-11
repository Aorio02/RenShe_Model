from api.utils.conversation_export import (
    build_download_filename,
    generate_markdown,
    normalize_export_content,
    render_markdown_html,
    resolve_message_content,
)


def test_normalize_export_content_handles_text_list():
    content = [
        {"type": "text", "text": "第一行"},
        {"type": "text", "text": "第二行"},
    ]
    assert normalize_export_content(content) == "第一行\n第二行"


def test_normalize_export_content_handles_dict_payload():
    assert normalize_export_content({"content": "正文"}) == "正文"


def test_generate_markdown_uses_normalized_content():
    markdown = generate_markdown(
        [
            {"role": "user", "content": [{"type": "text", "text": "你好"}]},
            {"role": "assistant", "content": {"content": "您好"}},
        ]
    )
    assert "## 用户" in markdown
    assert "你好" in markdown
    assert "## 助手" in markdown
    assert "您好" in markdown


def test_resolve_message_content_falls_back_to_answer_and_nested_data():
    assert resolve_message_content({"answer": "助手回答"}) == "助手回答"
    assert resolve_message_content({"data": {"answer": "嵌套回答"}}) == "嵌套回答"


def test_generate_markdown_skips_empty_messages_and_keeps_assistant_answer():
    markdown = generate_markdown(
        [
            {"role": "assistant", "content": ""},
            {"role": "assistant", "answer": "补偿回答"},
        ]
    )
    assert "补偿回答" in markdown
    assert markdown.count("## 助手") == 1


def test_render_markdown_html_supports_basic_table_output():
    html = render_markdown_html(
        "# 标题\n\n| 姓名 | 结果 |\n| --- | --- |\n| 张三 | 通过 |"
    )
    assert "<h1>标题</h1>" in html
    assert "<table>" in html
    assert "张三" in html


def test_build_download_filename_supports_utf8_and_ascii_fallback():
    original, disposition = build_download_filename("中文会话", ".pdf")
    assert original == "中文会话.pdf"
    assert 'filename="conversation.pdf"' in disposition
    assert "filename*=UTF-8''%E4%B8%AD%E6%96%87%E4%BC%9A%E8%AF%9D.pdf" in disposition
