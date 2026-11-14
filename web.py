#!/usr/bin/env python3
"""素の Claude とブラウザで話すためのローカルサーバー。

    export ANTHROPIC_API_KEY=sk-ant-...
    python web.py            # http://127.0.0.1:8765 が開く

APIキーはこのプロセスの中だけで使い、ブラウザには渡しません。
会話履歴はブラウザ (localStorage) に保存されます。
"""

import argparse
import json
import mimetypes
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import anthropic

WEB_DIR = Path(__file__).parent / "web"

# USD / 100万トークン。cache_read はキャッシュ読み出しの単価。
MODELS = {
    "claude-opus-5-5": {"label": "Claude Opus 5.5", "input": 4.00, "output": 20.00, "cache_read": 0.20},
    "claude-fable-5-2": {"label": "Claude Fable 5.2", "input": 8.00, "output": 40.00, "cache_read": 0.20},
    "claude-sonnet-5-5": {"label": "Claude Sonnet 5.5", "input": 2.00, "output": 10.00, "cache_read": 0.10},
    "claude-haiku-5-5": {"label": "Claude Haiku 5.5", "input": 0.10, "output": 0.50, "cache_read": 0.01},
}
DEFAULT_MODEL = "claude-opus-5-5"
EFFORTS = {"low", "medium", "high", "xhigh", "max"}

# 人間の会話は数分あくのが普通なので、キャッシュは 1 時間保持にする。
# 書き込みは入力単価の 2 倍、読み出しは上の cache_read 単価。
CACHE_CONTROL = {"type": "ephemeral", "ttl": "1h"}
CACHE_WRITE_MULTIPLIER = 2.0

# 安全分類器が応答を止めたとき、API 側で別モデルに引き継ぐ。
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FALLBACK_MODELS = {"claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"}

THINKING_TYPES = {"thinking", "redacted_thinking"}


def usage_summary(model, usage):
    """トークン内訳と概算コスト (USD) を返す。"""
    cache_read = usage.cache_read_input_tokens or 0
    cache_write = usage.cache_creation_input_tokens or 0
    summary = {
        "input": usage.input_tokens,
        "output": usage.output_tokens,
        "cache_read": cache_read,
        "cache_write": cache_write,
        "cost": None,
        "saved": None,
    }
    price = MODELS.get(model)
    if price:
        summary["cost"] = (
            usage.input_tokens * price["input"]
            + cache_write * price["input"] * CACHE_WRITE_MULTIPLIER
            + cache_read * price["cache_read"]
            + usage.output_tokens * price["output"]
        ) / 1_000_000
        summary["saved"] = cache_read * (price["input"] - price["cache_read"]) / 1_000_000
    return summary


def strip_thinking(messages):
    """履歴から思考ブロックを取り除く (署名が無効と言われたときの復旧用)。"""
    stripped = []
    for message in messages:
        content = message["content"]
        if isinstance(content, list):
            content = [b for b in content if b.get("type") not in THINKING_TYPES]
        stripped.append({**message, "content": content})
    return stripped


def build_params(body):
    model = body.get("model")
    if model not in MODELS:
        raise ValueError(f"未対応のモデルです: {model}")
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages が空です")

    params = {
        "model": model,
        "max_tokens": 64000,
        "messages": messages,
        "cache_control": CACHE_CONTROL,
        # 思考は要約を表示する (既定では空文字で返ってくる)。
        "thinking": {"type": "adaptive", "display": "summarized"},
    }
    # システムプロンプトは空なら送らない = 素の Claude。
    system = (body.get("system") or "").strip()
    if system:
        params["system"] = system
    if body.get("effort") in EFFORTS:
        params["output_config"] = {"effort": body["effort"]}
    return params


def open_stream(client, params):
    if params["model"] in FALLBACK_MODELS:
        return client.beta.messages.stream(betas=[FALLBACK_BETA], fallbacks="default", **params)
    return client.messages.stream(**params)


class Handler(BaseHTTPRequestHandler):
    client = None  # main() で設定
    server_version = "claude-chat"

    def log_message(self, fmt, *args):
        pass

    # --- 共通 ---

    def _local_request(self):
        """他のサイトからこのサーバーを叩かれないよう、Host と Origin を確認する。"""
        port = self.server.server_address[1]
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if self.headers.get("Host") not in allowed:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {f"http://{host}" for host in allowed}

    def _send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, payload):
        self._send(status, json.dumps(payload).encode(), "application/json")

    def _event(self, name, payload):
        data = json.dumps(payload, ensure_ascii=False)
        self.wfile.write(f"event: {name}\ndata: {data}\n\n".encode())
        self.wfile.flush()

    # --- ルーティング ---

    def do_GET(self):
        if not self._local_request():
            return self._json(403, {"error": "forbidden"})
        path = self.path.split("?")[0]
        if path == "/api/config":
            return self._json(200, {
                "models": [{"id": mid, **info} for mid, info in MODELS.items()],
                "defaultModel": DEFAULT_MODEL,
                "hasKey": self.client is not None,
            })
        name = "index.html" if path == "/" else path.lstrip("/")
        file = (WEB_DIR / name).resolve()
        if WEB_DIR.resolve() not in file.parents or not file.is_file():
            return self._json(404, {"error": "not found"})
        content_type = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        if content_type.startswith("text/") or content_type.endswith("javascript"):
            content_type += "; charset=utf-8"
        self._send(200, file.read_bytes(), content_type)

    def do_POST(self):
        if not self._local_request() or self.path != "/api/chat":
            return self._json(403, {"error": "forbidden"})
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            return self._json(415, {"error": "application/json で送ってください"})
        if self.client is None:
            return self._json(401, {"error": "ANTHROPIC_API_KEY が設定されていません。"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            params = build_params(body)
        except (ValueError, TypeError) as e:
            return self._json(400, {"error": str(e)})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self._chat(params)
        except (BrokenPipeError, ConnectionResetError):
            pass  # ブラウザ側で停止された。with を抜けた時点で API への接続も閉じている。

    # --- チャット本体 ---

    def _chat(self, params):
        try:
            try:
                self._stream(params, thinking_stripped=False)
            except anthropic.BadRequestError as e:
                # 思考ブロックの署名が通らない場合 (モデル切り替え後など) は、
                # 思考を外して一度だけやり直す。出力前に決まるエラーなので二重表示にはならない。
                if "signature" not in str(e.message):
                    raise
                params = {**params, "messages": strip_thinking(params["messages"])}
                self._stream(params, thinking_stripped=True)
        except anthropic.AuthenticationError:
            self._event("error", {"message": "APIキーが無効です。ANTHROPIC_API_KEY を確認してサーバーを起動し直してください。"})
        except anthropic.RateLimitError:
            self._event("error", {"message": "レート制限に達しました。少し待ってから再送してください。"})
        except anthropic.APIStatusError as e:
            self._event("error", {"message": f"APIエラー {e.status_code}: {e.message}"})
        except anthropic.APIConnectionError:
            self._event("error", {"message": "Claude API に接続できませんでした。ネットワークを確認してください。"})

    def _stream(self, params, thinking_stripped):
        with open_stream(self.client, params) as stream:
            for event in stream:
                if event.type == "content_block_delta":
                    if event.delta.type == "text_delta":
                        self._event("text", {"text": event.delta.text})
                    elif event.delta.type == "thinking_delta":
                        self._event("thinking", {"text": event.delta.thinking})
                elif event.type == "content_block_start" and event.content_block.type == "thinking":
                    self._event("thinking", {"text": ""})
            message = stream.get_final_message()

        # ブラウザが次のターンでそのまま送り返せるよう、API が返した形のまま渡す。
        content = [block.to_dict() for block in message.content]
        # 途中で別モデルに引き継がれたターンは、引き継ぎ前の思考ブロックを送り返せない。
        fallback_at = max((i for i, b in enumerate(content) if b["type"] == "fallback"), default=-1)
        content = [b for i, b in enumerate(content) if i > fallback_at or b["type"] not in THINKING_TYPES]
        self._event("done", {
            "content": content,
            "model": message.model,
            "stop_reason": message.stop_reason,
            "usage": usage_summary(message.model, message.usage),
            "thinking_stripped": thinking_stripped,
        })


def main():
    parser = argparse.ArgumentParser(description="素の Claude とブラウザで話す")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="ブラウザを自動で開かない")
    args = parser.parse_args()

    try:
        Handler.client = anthropic.Anthropic()
    except anthropic.AnthropicError:
        print("警告: APIキーが見つかりません。export ANTHROPIC_API_KEY=sk-ant-... してから起動し直してください。")

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}"
    print(f"{url} で起動しました (Ctrl+C で終了)")
    if not args.no_open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print()


if __name__ == "__main__":
    main()
