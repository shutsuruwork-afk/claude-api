# CLAUDE.md

## このリポジトリは公開 (public) です

- GitHub 上で誰でも閲覧できる。GitHub Pages でも公開する前提:
  https://shutsuruwork-afk.github.io/claude-api/
- **API キー・トークン・パスワード・個人情報（メールアドレス、本名、自宅 IP など）をコミットしない。**
  ログやスクリーンショット、テスト結果を追加するときも同様に確認する。
- 設定値や秘密情報が必要になったら、リポジトリには置かず環境変数や GitHub Secrets を使う。

## 内容

- `index.html` — WebRTC DataChannel の多対多 P2P 接続・同期テストページ（静的・ビルド不要、1 ファイル）。
  - ルーム: PeerJS 公開サーバー (0.peerjs.com) でシグナリング。ライブラリは `vendor/peerjs-1.5.4.min.js`（同梱、MIT）。
    **外部 CDN やワイルドカードのホストを新たに使わない**（利用者側の通信許可に数日かかるため）。
    通信先を増やす場合は README の「通信先」表も更新する。
    ルーム ID `p2pt-room-<名前>` を最初の参加者が「窓口」として確保し、新規参加者に一覧を渡す。
    以降は ID の小さい側が接続を開始してフルメッシュを維持し、状態 (`st`) をフラッディングで共有。
  - 同期: 操作ログ型 CRDT（Lamport 時刻 + 端末 ID で LWW）。操作は全接続に転送し、
    定期的な state vector (`sv`) 交換で欠けを補う。ハッシュは操作 ID の XOR（順序非依存）。
  - 手動モード: SDP をコピー＆ペーストで交換。STUN (stun.l.google.com) のみ使用。
- `.nojekyll` — GitHub Pages で Jekyll 処理を無効化。
- Hugging Face Space: https://huggingface.co/spaces/Lfood/p2p-test （static SDK）。
- `.github/workflows/deploy-hf-space.yml` — `main` 更新時に上記 Space へデプロイ（GitHub Secret `HF_TOKEN` 設定時のみ）。
  トークンは GitHub Secret `HF_TOKEN` のみに置く（リポジトリやログに出さない）。

## ローカル確認

```sh
python3 -m http.server 8000   # http://localhost:8000/
```

2 タブ開いて手動モードで接続すれば、外部ネットワークなしで動作確認できる。

多人数のテストは、npm の `peer` パッケージでローカルに PeerJS サーバーを立て
（例: `ExpressPeerServer` を 127.0.0.1:9000 で起動）、ページの「設定」でそのサーバーを指定する。
Playwright で複数の browser context を開けば 3〜5 台構成を自動テストできる。
