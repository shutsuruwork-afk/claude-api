#!/usr/bin/env python3
"""素の Claude と話すための最小チャット。

システムプロンプトなし・ツールなしで Claude API に直接つなぎます。
会話履歴はこのプロセスのメモリ上にだけ保持されます。

使い方:
    export ANTHROPIC_API_KEY=sk-ant-...
    python chat.py                      # Claude Opus 5.5
    python chat.py --model claude-fable-5-2

会話中のコマンド: /reset (履歴を消す)  /cost (累計コスト)  /exit (終了)
"""

import argparse
import sys

import anthropic

# 100万トークンあたりの USD (入力, 出力)。累計コストの目安表示に使う。
PRICES = {
    "claude-fable-5-2": (8.00, 40.00),
    "claude-opus-5-5": (4.00, 20.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-haiku-5-5": (0.10, 0.50),
}

# 安全分類器が応答を止めたとき、API 側で別モデルに引き継ぐ (止まったら表示する)。
FALLBACK_BETA = "server-side-fallback-2026-07-01"
FALLBACK_MODELS = {"claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"}


def turn_cost(model, usage):
    if model not in PRICES:
        return None
    in_price, out_price = PRICES[model]
    return (usage.input_tokens * in_price + usage.output_tokens * out_price) / 1_000_000


def send(client, model, messages):
    """1ターン送信し、応答をストリーム表示して最終メッセージを返す。"""
    params = dict(model=model, max_tokens=64000, messages=messages)
    if model in FALLBACK_MODELS:
        stream_cm = client.beta.messages.stream(
            betas=[FALLBACK_BETA], fallbacks="default", **params
        )
    else:
        stream_cm = client.messages.stream(**params)

    with stream_cm as stream:
        for text in stream.text_stream:
            print(text, end="", flush=True)
        print()
        return stream.get_final_message()


def main():
    parser = argparse.ArgumentParser(description="素の Claude と話す")
    parser.add_argument("--model", default="claude-opus-5-5")
    args = parser.parse_args()

    client = anthropic.Anthropic()
    messages = []
    total = 0.0

    print(f"{args.model} / システムプロンプトなし  (/reset /cost /exit)\n")

    while True:
        try:
            user_input = input("あなた> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break

        if not user_input:
            continue
        if user_input == "/exit":
            break
        if user_input == "/reset":
            messages.clear()
            print("(履歴を消しました)\n")
            continue
        if user_input == "/cost":
            print(f"(累計 約 ${total:.4f})\n")
            continue

        messages.append({"role": "user", "content": user_input})
        print("\nClaude> ", end="", flush=True)

        try:
            message = send(client, args.model, messages)
        except KeyboardInterrupt:
            messages.pop()
            print("\n(中断しました。この発言は履歴に残しません)\n")
            continue
        except anthropic.AuthenticationError:
            sys.exit("\nAPIキーが無効です。ANTHROPIC_API_KEY を確認してください。")
        except anthropic.RateLimitError:
            messages.pop()
            print("\n(レート制限に達しました。少し待ってからもう一度送ってください)\n")
            continue
        except anthropic.APIStatusError as e:
            messages.pop()
            print(f"\n(APIエラー {e.status_code}: {e.message})\n")
            continue
        except anthropic.APIConnectionError:
            messages.pop()
            print("\n(接続できませんでした。ネットワークを確認してください)\n")
            continue

        if message.stop_reason == "refusal":
            # 拒否されたターンは履歴に残さない (残すと次の送信も失敗しうる)。
            messages.pop()
            print("(安全フィルタにより応答が止められました)")
        else:
            if message.model != args.model:
                print(f"(このターンは {message.model} が応答しました)")
            if message.stop_reason == "max_tokens":
                print("(出力上限に達したため途中で切れています)")
            # thinking ブロックなども含め、content をそのまま履歴に戻す。
            messages.append({"role": "assistant", "content": message.content})

        cost = turn_cost(message.model, message.usage)
        if cost is not None:
            total += cost
        usage = message.usage
        cost_note = f" / 約 ${cost:.4f} (累計 ${total:.4f})" if cost is not None else ""
        print(f"[入力 {usage.input_tokens} / 出力 {usage.output_tokens} トークン{cost_note}]\n")


if __name__ == "__main__":
    main()
