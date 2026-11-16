# CLAUDE.md

## このリポジトリは公開 (public) です

- GitHub 上で誰でも閲覧できる。GitHub Pages でも公開する前提:
  https://shutsuruwork-afk.github.io/claude-api/
- **API キー・トークン・パスワード・個人情報（メールアドレス、本名、自宅 IP など）をコミットしない。**
  ログやスクリーンショット、テスト結果を追加するときも同様に確認する。
- 設定値や秘密情報が必要になったら、リポジトリには置かず環境変数や GitHub Secrets を使う。

## 内容

- `index.html` — WebRTC DataChannel の多対多 P2P 接続・同期テストページ（静的・ビルド不要、1 ファイル）。
  - ルーム: PeerJS 公開サーバー (0.peerjs.com) でシグナリング。PeerJS 1.5.4（MIT）を `index.html` に直接埋め込み、
    ファイル単体（file://）で動くようにしている。利用者はファイルをダウンロードして開く運用を想定。
    **外部 CDN・別ファイル・新しいホスト（特にワイルドカードが必要なもの）を増やさない**
    （利用者側の通信許可は完全一致のドメイン単位で、追加に数日かかるため）。
    通信先を増やす場合は README の「通信先」表も更新する。
    ルーム ID `p2pt-room-<名前>` を最初の参加者が「窓口」として確保し、新規参加者に一覧を渡す。
    （PeerJS の ID 規則に合わない名前＝日本語・空白などは `beaconIdOf` がハッシュに置き換える。）
    窓口の引き継ぎに失敗した端末は窓口へ問い合わせ、分かれたグループを合流させる。
    以降は ID の小さい側が接続を開始してフルメッシュを維持し、状態 (`st`) をフラッディングで共有。
  - 同期: 操作ログ型 CRDT（Lamport 時刻 + 端末 ID で LWW）。操作は全接続に転送し、
    定期的な state vector (`sv`) 交換で欠けを補う。ハッシュは操作 ID の XOR（順序非依存）。
  - 手動モード: SDP をコピー＆ペーストで交換。STUN (stun.l.google.com) のみ使用。
  - リアルタイム通信テスト: 各接続の RTCPeerConnection に negotiated な非信頼 DataChannel（id 100, ordered:false,
    maxRetransmits:0）を追加し、メインの信頼チャネルと比較。開始 (`rtstart`) と結果 (`rtres`) はフラッディングで全員に配る。
- `.nojekyll` — GitHub Pages で Jekyll 処理を無効化。
- 自動テスト（`runAuto`）: 端末単体の確認 → ルーム全員でのテストを順に実行し、`deriveCaps` で
  「使える/条件付き/使えない/未検証」を判定。進捗 (`autostep`) と結果 (`autores`) はフラッディングで全員に配り、
  各端末の localStorage（`p2pt.history`、最大 100 件）に保存。結果には IP を含めない（`maskIps` を通す）。
  判定項目を足すときは `deriveCaps` と TESTING.md の「結果から決める」表を合わせて更新する。
- `TESTING.md` — 実機テストの手順（自動テスト中心）と「何が作れるか」の判定表。
- 「結果レポートをコピー」はテキストを生成する際に IP アドレスを `[IP]` に伏せる。レポートに新しい項目を足すときも IP を含めない。

## ローカル確認

```sh
python3 -m http.server 8000   # http://localhost:8000/
```

2 タブ開いて手動モードで接続すれば、外部ネットワークなしで動作確認できる。

多人数のテストは、npm の `peer` パッケージでローカルに PeerJS サーバーを立て
（例: `ExpressPeerServer` を 127.0.0.1:9000 で起動）、ページの「設定」でそのサーバーを指定する。
Playwright で複数の browser context を開けば 3〜5 台構成を自動テストできる。
