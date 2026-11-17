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
    **チャネルが開いた瞬間に応答側（接続を受けた側）が送る最初のメッセージは、ブラウザがまれに落とす**（Chromium で確認。接続自体は正常）。
    そのため一覧は参加者からの要求 (`q`) にも応答し、`hello` は 300ms 後に再送する。開通直後の 1 通に依存する処理を足さない。
    **相手の発見は P2P の成否に依存させない。** 接続要求（OFFER）はシグナリングサーバー経由で届くので、`peer.on('connection')` /
    `bp.on('connection')` の時点で `noteSignal` で相手をメンバーに登録する（名前と直接知っている相手の一覧は接続の `metadata` で渡す）。
    窓口は 1.5 秒たっても参加者とつながっていなければ自分から接続しに行く。これで端末同士の通信が塞がれていても
    「相手は見つかったが直接つながらない」と表示・判定できる（判定キー `reach`）。`metadata` も信用しない値として検証する。
    以降は ID の小さい側が接続を開始してフルメッシュを維持し、状態 (`st`) をフラッディングで共有。
  - 同期: 操作ログ型 CRDT（Lamport 時刻 + 端末 ID で LWW）。操作は全接続に転送し、
    定期的な state vector (`sv`) 交換で欠けを補う。ハッシュは操作 ID の XOR（順序非依存）。
    「全消去」は epoch を 1 つ進める（`adoptEpoch`）。古い epoch の操作は全端末で破棄され、`sv` の `ep` で伝わる。
  - 手動モード: SDP をコピー＆ペーストで交換。STUN (stun.l.google.com) のみ使用。
  - リアルタイム通信テスト: 各接続の RTCPeerConnection に negotiated な非信頼 DataChannel（id 100, ordered:false,
    maxRetransmits:0）を追加し、メインの信頼チャネルと比較。開始 (`rtstart`) と結果 (`rtres`) はフラッディングで全員に配る。
  - 長時間テスト: `ltstart` をフラッディングし、各端末が 20 回/秒の `lp`/`lq` を相手ごとに送って区間（既定 60 秒）ごとに記録、
    結果 `ltres`（`cleanLt`）を集めて開始端末が `buildLongResult` で自動テストと同じ形式の結果にし、`autores` で共有・履歴保存する（判定キー `long` / `longdrop`）。
    判定の閾値を変えたら TESTING.md の「8. 長時間テスト」の表も合わせる。
  - TURN は `turnCheck` が URL ごと（UDP / TCP / TLS）に中継のみのループバックで確認する。TURN の認証情報はコミットしない。
  - **他端末から届く値は信用しない。** メッセージは `handleMessage` で型・範囲を確認し、状態は `cleanStatus` / `cleanRt` / `validResult` を通してから保存・表示する。
    色は `safeColor`、文字列は `esc`/`txt` を必ず通す（`String(x)` は細工された値で例外になるので使わない）。新しいメッセージ種別を足すときも同じ。
  - 経路の `H`/`S` は `sameLan` で候補アドレスを比較して決める（アドレスは比較にだけ使い、保存・表示しない）。
  - **同時に開始された全員テストは 1 つにまとめる。** 自動テスト・長時間テスト・リアルタイムテストは、同じ瞬間に 2 台で開始されたら
    全端末が同じ規則（ID の小さい実行を残す）で片方をやめる。自動テスト中は 10 秒ごとに `autostep` を流し、他の端末の開始ボタンを無効にする（`autoBusy`）。
    全員で動かすテストを足すときも、同時開始でどうなるかを決めてテストを書く。
  - `BUILD`（ページ上部の「版」）: 挙動を変えたら必ず更新する。写真や結果レポートからどの版かを判別するのに使う。
  - 診断を含め、IP アドレスは画面にも表示しない（利用者が画面の写真を共有するため）。
  - 「LAN 内の直接接続を助ける」は getUserMedia の許可でブラウザの mDNS によるローカル IP 隠しを外す（マイクは使わず即停止）。
- `.nojekyll` — GitHub Pages で Jekyll 処理を無効化。
- `tests/` — E2E テスト（`e2e.js`、ローカル PeerJS サーバー + Playwright）。`.github/workflows/test.yml` が push ごとに実行。
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

これをまとめたものが `tests/e2e.js`:

```sh
cd tests && npm install && npx playwright install chromium && npm test
node e2e.js 窓口          # 名前に「窓口」を含むテストだけ
SKIP_SLOW=1 npm test     # 自動テスト（約 1 分）を省略
CHROMIUM_PATH=/path/to/chromium npm test   # インストール済みの Chromium を使う
```

`index.html` の挙動を変えたら、対応するテストを `tests/e2e.js` に足してから push する。

端末同士の通信が塞がれた状態は、設定を `{ ice: [], relayOnly: true }` にすると再現できる（候補が 1 つも出ないので P2P だけが失敗する）。
本物の公開サーバーでの確認は `node tests/real-server.js index.html`（手動用。CI では実行しない）。
