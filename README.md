# claude-api

素の Claude と話すためのチャット。システムプロンプトなし・ツールなしで Claude API に直接つなぎます。ブラウザ版(`web.py`)とターミナル版(`chat.py`)があります。

## 準備

1. [Claude Console](https://platform.claude.com/) にログインし、クレジットが残高に入っていることを確認する
2. Console の「API keys」でキーを作成する(`sk-ant-...`。表示は一度きり)
3. 手元のPCで:

```bash
git clone https://github.com/shutsuruwork-afk/claude-api.git
cd claude-api
git checkout claude/loving-cray-zq9hr2
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...   # キーはファイルに書かず、コミットしない
```

## 使い方(ブラウザ)

```bash
python web.py
```

ブラウザで http://127.0.0.1:8765 が開きます。終了はターミナルで Ctrl+C。

- **素の Claude**: システムプロンプトは送りません。付けたいときだけ、会話を始める前の画面で入力できます
- **モデルと思考の深さ**: 画面上部で切り替え。既定は Claude Opus 5.5
- **プロンプトキャッシュ**: 会話履歴を 1 時間キャッシュします。2 ターン目以降は履歴の大半が通常の入力単価の数%で済み、各応答の下に「キャッシュ利用」として表示されます
- **コスト表示**: 応答ごとの概算、会話ごとの合計、これまでの累計とキャッシュによる節約額
- **会話の保存**: 会話はブラウザ(localStorage)に残り、左の一覧から再開できます
- **その他**: 途中停止、再生成、思考の要約表示、Markdown とコードのハイライト、ダーク/ライト自動切り替え

API キーは `web.py` のプロセスだけが持ち、ブラウザには渡りません。サーバーは自分の PC(127.0.0.1)からしか使えません。

## 使い方(ターミナル)

```bash
python chat.py                           # Claude Opus 5.5
python chat.py --model claude-fable-5-2  # 最上位モデル
python chat.py --model claude-haiku-5-5  # 最安
```

会話中のコマンド: `/reset`(履歴を消す) `/cost`(累計コスト) `/exit`(終了)。ターミナル版はキャッシュを使いません。

## 料金の目安

会話が長くなるほど、毎回それまでの履歴全体を入力として送ります。ブラウザ版はその履歴をキャッシュから読むので、増え方がずっと緩やかです。

| モデル | 入力 $/100万トークン | キャッシュ読み出し | 出力 |
| --- | --- | --- | --- |
| `claude-fable-5-2` | 8.00 | 0.20 | 40.00 |
| `claude-opus-5-5` | 4.00 | 0.20 | 20.00 |
| `claude-sonnet-5-5` | 2.00 | 0.10 | 10.00 |
| `claude-haiku-5-5` | 0.10 | 0.01 | 0.50 |

キャッシュへの書き込み(各ターンで新しく増えた分)は入力単価の 2 倍です。画面のコストは概算で、正確な請求額は Console で確認してください。

## 「素」の範囲

- システムプロンプトは送っていません。claude.ai アプリのような性格付け・日付・ツールの指示は一切入りません
- 会話をまたいだ記憶はありません。各会話は、その会話の履歴だけを毎回送っています
- 安全分類器が応答を止めた場合に API 側で別モデルへ引き継ぐ設定(`fallbacks`)を有効にしています。引き継ぎが起きたターンはその旨を表示します

## 同梱ライブラリ

`web/vendor/` に marked 12.0.2(MIT)、DOMPurify 3.1.6(Apache-2.0 / MPL-2.0)、highlight.js 11.9.0(BSD-3-Clause)を同梱しています。
