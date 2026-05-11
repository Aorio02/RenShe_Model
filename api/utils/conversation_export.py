#
#  Copyright 2026 The InfiniFlow Authors. All Rights Reserved.
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
import json
import logging
import re
import tempfile
import urllib.parse
from datetime import datetime
from pathlib import Path

from api.utils.web_utils import html2pdf

try:
    import markdown as markdown_lib
except Exception:  # pragma: no cover - optional runtime dependency fallback
    markdown_lib = None


def normalize_export_content(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(str(item.get("text", "")))
                elif "content" in item:
                    parts.append(str(item.get("content", "")))
                else:
                    parts.append(json.dumps(item, ensure_ascii=False))
            else:
                parts.append(str(item))
        return "\n".join(part for part in parts if part)
    if isinstance(content, dict):
        if "text" in content:
            return str(content.get("text", ""))
        if "content" in content:
            return str(content.get("content", ""))
        return json.dumps(content, ensure_ascii=False)
    return str(content)


def resolve_message_content(message) -> str:
    if not isinstance(message, dict):
        return normalize_export_content(message)

    for field in ("content", "answer", "text"):
        value = message.get(field)
        if value not in (None, ""):
            normalized = normalize_export_content(value).strip()
            if normalized:
                return normalized

    data = message.get("data")
    if isinstance(data, dict):
        for field in ("content", "answer", "text"):
            value = data.get(field)
            if value not in (None, ""):
                normalized = normalize_export_content(value).strip()
                if normalized:
                    return normalized

    return ""


def build_download_filename(filename: str, extension: str = ".pdf") -> tuple[str, str]:
    base_name = (filename or "conversation").strip() or "conversation"
    if not base_name.lower().endswith(extension.lower()):
        base_name = f"{base_name}{extension}"

    stem, ext = re.match(r"^(.*?)(\.[^.]+)?$", base_name).groups()
    ext = ext or extension
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", stem).strip("._")
    safe_ascii = f"{safe_stem or 'conversation'}{ext}"
    encoded = urllib.parse.quote(base_name, encoding="utf-8")
    disposition = f'attachment; filename="{safe_ascii}"; filename*=UTF-8\'\'{encoded}'
    return base_name, disposition


def generate_markdown(messages):
    markdown_lines = ["# 会话导出", ""]

    for msg in messages or []:
        role = msg.get("role", "")
        content = resolve_message_content(msg)
        if not content:
            continue

        if role == "user":
            markdown_lines.append("## 用户")
        elif role == "assistant":
            markdown_lines.append("## 助手")
        else:
            markdown_lines.append(f"## {role}")

        markdown_lines.append(content)
        markdown_lines.append("")

    return "\n".join(markdown_lines)


def extract_table_from_messages(messages):
    logging.info("[DEBUG] extract_table_from_messages: 共 %s 条消息", len(messages or []))

    last_table = None
    last_table_index = -1
    markdown_table_pattern = r"\|.+\|[\r\n]+\|[-:|\s]+\|[\r\n]+(?:\|.+\|[\r\n]*)+"

    for i, msg in enumerate(messages or []):
        role = msg.get("role", "")
        content = resolve_message_content(msg)

        if role == "assistant" and "|" in content:
            matches = re.findall(markdown_table_pattern, content, re.MULTILINE)
            if matches:
                last_table = matches[0]
                last_table_index = i
                logging.info("[DEBUG] 消息 %s 包含表格，长度=%s", i, len(content))

    if last_table:
        logging.info("[DEBUG] 返回消息 %s 的表格", last_table_index)

    return last_table


def generate_table_markdown(conversation, messages):
    markdown_lines = [
        "# 业务办理表格",
        "",
        "## 基本信息",
        "",
        f"- **会话名称**: {getattr(conversation, 'name', None) or '未命名'}",
        f"- **导出时间**: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
        "## 业务办理信息",
        "",
    ]

    table_content = extract_table_from_messages(messages)
    if table_content:
        markdown_lines.append(table_content)
    else:
        markdown_lines.append("*未找到生成的业务表格，请确认是否已点击「生成业务表格」按钮。*")

    return "\n".join(markdown_lines)


def _escape_html(text: str) -> str:
    return (
        (text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _format_inline_markdown(text: str) -> str:
    escaped = _escape_html(text)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    escaped = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<em>\1</em>", escaped)
    return escaped


def _is_table_separator(line: str) -> bool:
    normalized = line.strip().strip("|").strip()
    if not normalized:
        return False
    cells = [cell.strip() for cell in normalized.split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def _split_table_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _render_table_html(lines: list[str]) -> str:
    header_cells = _split_table_row(lines[0])
    body_lines = lines[2:]
    parts = [
        "<table>",
        "<thead><tr>",
        "".join(f"<th>{_format_inline_markdown(cell)}</th>" for cell in header_cells),
        "</tr></thead>",
        "<tbody>",
    ]
    for line in body_lines:
        cells = _split_table_row(line)
        parts.append("<tr>")
        parts.append("".join(f"<td>{_format_inline_markdown(cell)}</td>" for cell in cells))
        parts.append("</tr>")
    parts.extend(["</tbody>", "</table>"])
    return "".join(parts)


def _render_basic_markdown_html(markdown_content: str) -> str:
    lines = (markdown_content or "").replace("\r\n", "\n").split("\n")
    blocks = []
    paragraph_lines = []
    list_items = []
    index = 0

    def flush_paragraph():
        nonlocal paragraph_lines
        if paragraph_lines:
            blocks.append(
                "<p>{}</p>".format("<br />".join(_format_inline_markdown(line) for line in paragraph_lines))
            )
            paragraph_lines = []

    def flush_list():
        nonlocal list_items
        if list_items:
            blocks.append(
                "<ul>{}</ul>".format("".join(f"<li>{_format_inline_markdown(item)}</li>" for item in list_items))
            )
            list_items = []

    while index < len(lines):
        line = lines[index]
        stripped = line.strip()

        if not stripped:
            flush_paragraph()
            flush_list()
            index += 1
            continue

        if index + 1 < len(lines) and "|" in stripped and _is_table_separator(lines[index + 1]):
            flush_paragraph()
            flush_list()
            table_lines = [line, lines[index + 1]]
            index += 2
            while index < len(lines) and "|" in lines[index]:
                table_lines.append(lines[index])
                index += 1
            blocks.append(_render_table_html(table_lines))
            continue

        if stripped.startswith("### "):
            flush_paragraph()
            flush_list()
            blocks.append(f"<h3>{_format_inline_markdown(stripped[4:].strip())}</h3>")
            index += 1
            continue

        if stripped.startswith("## "):
            flush_paragraph()
            flush_list()
            blocks.append(f"<h2>{_format_inline_markdown(stripped[3:].strip())}</h2>")
            index += 1
            continue

        if stripped.startswith("# "):
            flush_paragraph()
            flush_list()
            blocks.append(f"<h1>{_format_inline_markdown(stripped[2:].strip())}</h1>")
            index += 1
            continue

        if stripped.startswith("- "):
            flush_paragraph()
            list_items.append(stripped[2:].strip())
            index += 1
            continue

        flush_list()
        paragraph_lines.append(line)
        index += 1

    flush_paragraph()
    flush_list()
    return "".join(blocks)


def render_markdown_html(markdown_content: str) -> str:
    if markdown_lib is not None:
        try:
            return markdown_lib.markdown(
                markdown_content or "",
                extensions=["tables", "fenced_code", "nl2br", "sane_lists"],
            )
        except Exception:
            logging.exception("Failed to render markdown with markdown library, falling back to basic renderer")
    return _render_basic_markdown_html(markdown_content)


def markdown_to_pdf_bytes(markdown_content: str, title: str) -> bytes:
    body_html = render_markdown_html(markdown_content)
    html_content = f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>{_escape_html(title or "会话导出")}</title>
    <style>
      @page {{
        size: A4;
        margin: 16mm 14mm;
      }}
      body {{
        font-family: "Noto Sans CJK SC", "Noto Sans CJK", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #1f2937;
        font-size: 12px;
        line-height: 1.7;
        word-break: break-word;
      }}
      h1 {{
        font-size: 20px;
        margin: 0 0 12px;
      }}
      h2 {{
        font-size: 16px;
        margin: 16px 0 8px;
      }}
      h3 {{
        font-size: 14px;
        margin: 12px 0 6px;
      }}
      p {{
        margin: 0 0 6px;
        white-space: pre-wrap;
      }}
      ul {{
        margin: 0 0 8px 20px;
        padding: 0;
      }}
      li {{
        margin: 0 0 4px;
      }}
      table {{
        width: 100%;
        border-collapse: collapse;
        margin: 8px 0 12px;
        table-layout: fixed;
      }}
      th, td {{
        border: 1px solid #d1d5db;
        padding: 6px 8px;
        vertical-align: top;
        text-align: left;
        word-break: break-word;
      }}
      th {{
        background: #f3f4f6;
        font-weight: 600;
      }}
      code {{
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        background: #f3f4f6;
        border-radius: 4px;
        padding: 1px 4px;
      }}
    </style>
  </head>
  <body>
    {body_html}
  </body>
</html>
"""
    with tempfile.NamedTemporaryFile("w", suffix=".html", encoding="utf-8", delete=False) as html_file:
        html_file.write(html_content)
        html_path = Path(html_file.name)

    try:
        return html2pdf(html_path.as_uri(), timeout=5, install_driver=False)
    finally:
        try:
            html_path.unlink(missing_ok=True)
        except Exception:
            logging.exception("Failed to remove temporary export html file")
