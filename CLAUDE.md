# CLAUDE.md

## このリポジトリは公開 (public) です

- GitHub 上で誰でも閲覧できる。GitHub Pages でも公開する前提:
  https://shutsuruwork-afk.github.io/claude-api/
- **API キー・トークン・パスワード・個人情報（メールアドレス、本名、自宅 IP など）をコミットしない。**
  ログやスクリーンショット、テスト結果を追加するときも同様に確認する。
- 設定値や秘密情報が必要になったら、リポジトリには置かず環境変数や GitHub Secrets を使う。

## 内容

- `index.html` — WebRTC DataChannel の P2P 接続テストページ（静的・ビルド不要）。
  - PeerJS モード: シグナリングに PeerJS 公開サーバー (0.peerjs.com) と unpkg.com を使用。
  - 手動モード: SDP をコピー＆ペーストで交換。STUN (stun.l.google.com) のみ使用。
- `.nojekyll` — GitHub Pages で Jekyll 処理を無効化。

## ローカル確認

```sh
python3 -m http.server 8000   # http://localhost:8000/
```

2 タブ開いて手動モードで接続すれば、外部ネットワークなしで動作確認できる。
