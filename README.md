# claude-api
Chat with claude

> **このリポジトリは公開 (public) です。** 秘密情報や個人情報をコミットしないでください。
>
> 公開ページ: https://shutsuruwork-afk.github.io/claude-api/

## P2P 接続テスト (GitHub Pages)

`index.html` は WebRTC DataChannel で 2 端末が直接つながるか確認するページです。

- **かんたん (PeerJS)**: 片方の ID をもう片方に入力して接続。シグナリングのみ PeerJS 公開サーバーを使用。
- **手動 (サーバーなし)**: SDP をコピー＆ペーストで交換。STUN 以外の外部サーバー不要。

接続後、経路（host / srflx / relay）と RTT、Ping 結果が表示されます。
