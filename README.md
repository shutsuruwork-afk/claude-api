# claude-api

素の Claude と話すための最小チャット。システムプロンプトなし・ツールなしで Claude API に直接つなぎます。

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

## 使い方

```bash
python chat.py                           # Claude Opus 5.5
python chat.py --model claude-fable-5-2  # 最上位モデル
python chat.py --model claude-haiku-5-5  # 最安
```

会話中のコマンド: `/reset`(履歴を消す) `/cost`(累計コスト) `/exit`(終了)

各ターンの後にトークン数と概算コストが表示されます。会話が長くなるほど、毎回それまでの履歴全体を入力として送るので 1 ターンあたりのコストは増えます。`/reset` で戻せます。

| モデル | 入力 $/100万トークン | 出力 $/100万トークン |
| --- | --- | --- |
| `claude-fable-5-2` | 8.00 | 40.00 |
| `claude-opus-5-5` | 4.00 | 20.00 |
| `claude-sonnet-5-5` | 2.00 | 10.00 |
| `claude-haiku-5-5` | 0.10 | 0.50 |

## 「素」の範囲

- システムプロンプトは送っていません。claude.ai アプリのような性格付け・日付・ツールの指示は一切入りません
- 会話の記憶はこのプロセスの中だけ。終了すると消えます
- 安全分類器が応答を止めた場合に API 側で別モデルへ引き継ぐ設定(`fallbacks`)を有効にしています。引き継ぎが起きたターンはその旨を表示します
