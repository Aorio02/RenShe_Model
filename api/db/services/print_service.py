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
import html
import logging
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from api.utils.web_utils import html2pdf


class ConversationPrintService:
    @classmethod
    def _cups_env(cls) -> dict:
        env = os.environ.copy()
        cups_server = os.getenv("RAGFLOW_CUPS_SERVER", "").strip()
        if cups_server:
            env["CUPS_SERVER"] = cups_server
        return env

    @classmethod
    def _require_command(cls, command: str):
        if shutil.which(command):
            return
        raise RuntimeError(f"Missing required print command: {command}")

    @classmethod
    def list_printers(cls) -> list[dict]:
        cls._require_command("lpstat")
        env = cls._cups_env()

        result = subprocess.run(
            ["lpstat", "-p", "-d"],
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )
        if result.returncode != 0:
            stderr = (result.stderr or result.stdout or "").strip()
            raise RuntimeError(stderr or "Failed to list printers")

        default_printer = None
        printers = []
        for raw_line in result.stdout.splitlines():
            line = raw_line.strip()
            if not line:
                continue
            if line.startswith("system default destination:"):
                default_printer = line.split(":", 1)[1].strip() or None
                continue
            if not line.startswith("printer "):
                continue
            match = re.match(r"printer\s+(\S+)\s+(.+)", line)
            if not match:
                continue
            name = match.group(1)
            status = match.group(2).strip()
            printers.append(
                {
                    "name": name,
                    "is_default": name == default_printer,
                    "status": status,
                }
            )

        return printers

    @classmethod
    def _sanitize_title(cls, title: str) -> str:
        value = (title or "conversation").strip() or "conversation"
        value = re.sub(r"[\r\n\t]+", " ", value)
        return re.sub(r"\s{2,}", " ", value)[:120]

    @classmethod
    def _markdown_to_html(cls, markdown_content: str, title: str) -> str:
        escaped_title = html.escape(title)
        escaped_body = html.escape(markdown_content or "")
        body_html = escaped_body.replace("\r\n", "\n").replace("\n", "<br />\n")

        return f"""<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>{escaped_title}</title>
    <style>
      @page {{
        size: A4;
        margin: 18mm 14mm;
      }}
      body {{
        font-family: "Noto Sans CJK SC", "Noto Sans CJK", "PingFang SC", "Microsoft YaHei", sans-serif;
        font-size: 13px;
        line-height: 1.6;
        color: #1f2937;
        white-space: normal;
        word-break: break-word;
      }}
      h1 {{
        font-size: 22px;
        margin: 0 0 16px;
      }}
      .content {{
        white-space: normal;
      }}
      .pre {{
        white-space: pre-wrap;
      }}
    </style>
  </head>
  <body>
    <h1>{escaped_title}</h1>
    <div class="content pre">{body_html}</div>
  </body>
</html>
"""

    @classmethod
    def _render_pdf(cls, markdown_content: str, title: str) -> bytes:
        html_content = cls._markdown_to_html(markdown_content, title)
        with tempfile.NamedTemporaryFile("w", suffix=".html", encoding="utf-8", delete=False) as html_file:
            html_file.write(html_content)
            html_path = Path(html_file.name)

        try:
            return html2pdf(html_path.as_uri(), timeout=5, install_driver=False)
        finally:
            try:
                html_path.unlink(missing_ok=True)
            except Exception:
                logging.exception("Failed to remove temporary html file")

    @classmethod
    def print_markdown(cls, printer_name: str, markdown_content: str, title: str, copies: int = 1) -> dict:
        cls._require_command("lp")
        title = cls._sanitize_title(title)
        printer_name = (printer_name or "").strip()
        if not printer_name:
            raise RuntimeError("Printer name is required")

        pdf_bytes = cls._render_pdf(markdown_content, title)
        if not pdf_bytes:
            raise RuntimeError("Failed to render PDF for printing")

        env = cls._cups_env()
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as pdf_file:
            pdf_file.write(pdf_bytes)
            pdf_path = Path(pdf_file.name)

        try:
            command = [
                "lp",
                "-d",
                printer_name,
                "-t",
                title,
                "-n",
                str(max(1, copies)),
                str(pdf_path),
            ]
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                env=env,
                check=False,
            )
            if result.returncode != 0:
                stderr = (result.stderr or result.stdout or "").strip()
                raise RuntimeError(stderr or "Failed to submit print job")

            output = (result.stdout or "").strip()
            job_id_match = re.search(r"request id is\s+(\S+)", output)
            return {
                "printer_name": printer_name,
                "title": title,
                "copies": max(1, copies),
                "job_id": job_id_match.group(1) if job_id_match else "",
                "message": output or "Print job submitted",
            }
        finally:
            try:
                pdf_path.unlink(missing_ok=True)
            except Exception:
                logging.exception("Failed to remove temporary pdf file")
