#!/usr/bin/env python3
"""铸文 LongCat gateway.

This process is intentionally isolated from the Electron app and from the
other services on the host. It forwards only OpenAI-compatible chat requests,
keeps the LongCat key server-side, and applies conservative request limits.
"""
import json
import os
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


HOST = os.getenv("ZHUWEN_GATEWAY_HOST", "127.0.0.1")
PORT = int(os.getenv("ZHUWEN_GATEWAY_PORT", "8100"))
LONGCAT_URL = os.getenv(
    "ZHUWEN_LONGCAT_URL", "https://api.longcat.chat/openai/v1/chat/completions"
)
LONGCAT_KEY = os.getenv("ZHUWEN_LONGCAT_API_KEY", "")
CLIENT_TOKEN = os.getenv("ZHUWEN_CLIENT_TOKEN", "")
FIXED_MODEL = os.getenv("ZHUWEN_LONGCAT_MODEL", "LongCat-2.0")
MAX_CONTEXT_CHARS = int(os.getenv("ZHUWEN_MAX_CONTEXT_CHARS", "300000"))
MAX_OUTPUT_TOKENS = int(os.getenv("ZHUWEN_MAX_OUTPUT_TOKENS", "20000"))


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    server_version = "ZhuwenLongCatGateway/1.0"

    def log_message(self, fmt, *args):
        # Do not log prompts or credentials.
        super().log_message(fmt, *args)

    def send_json(self, status, value):
        data = json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def authorized(self):
        if not CLIENT_TOKEN:
            return False
        supplied = self.headers.get("Authorization", "")
        return supplied == "Bearer " + CLIENT_TOKEN

    def do_GET(self):
        if self.path in ("/health", "/v1/health"):
            self.send_json(
                200,
                {
                    "ok": bool(LONGCAT_KEY and CLIENT_TOKEN),
                    "service": "zhuwen-longcat",
                    "model": FIXED_MODEL,
                    "max_context_chars": MAX_CONTEXT_CHARS,
                },
            )
            return
        self.send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": {"message": "not found"}})
            return
        if not self.authorized():
            self.send_json(401, {"error": {"message": "invalid gateway token"}})
            return
        if not LONGCAT_KEY:
            self.send_json(503, {"error": {"message": "LongCat API key is not configured"}})
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size <= 0 or size > 8 * 1024 * 1024:
                raise ValueError("request body is too large")
            payload = json.loads(self.rfile.read(size))
            messages = payload.get("messages")
            if not isinstance(messages, list) or not messages:
                raise ValueError("messages is required")
            context_chars = sum(len(str(m.get("content", ""))) for m in messages)
            if context_chars > MAX_CONTEXT_CHARS:
                self.send_json(
                    413,
                    {"error": {"message": f"context exceeds {MAX_CONTEXT_CHARS} chars"}},
                )
                return
            payload["model"] = FIXED_MODEL
            payload["max_tokens"] = min(
                max(1, int(payload.get("max_tokens") or 1)), MAX_OUTPUT_TOKENS
            )
            request = urllib.request.Request(
                LONGCAT_URL,
                data=json_bytes(payload),
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + LONGCAT_KEY,
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=600) as upstream:
                self.send_response(upstream.status)
                self.send_header(
                    "Content-Type",
                    upstream.headers.get("Content-Type", "application/json"),
                )
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Zhuwen-Model", FIXED_MODEL)
                self.end_headers()
                while True:
                    chunk = upstream.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except urllib.error.HTTPError as error:
            body = error.read(2000).decode("utf-8", "replace")
            self.send_json(error.code, {"error": {"message": body[:1500]}})
        except (TimeoutError, urllib.error.URLError) as error:
            self.send_json(504, {"error": {"message": "LongCat upstream unavailable"}})
        except Exception as error:
            self.send_json(400, {"error": {"message": str(error)[:500]}})


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
