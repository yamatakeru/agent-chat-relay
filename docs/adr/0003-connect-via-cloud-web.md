---
status: accepted
---

# アダプターは Bridge ではなく、標準 platform の cloud_web で cc-connect につなぐ

ADR 0001 で決めた自作アダプターの、cc-connect へのつなぎ方を変える。Bridge から、cc-connect 1.5.0 で入った標準 platform の cloud_web（CWIP v1）にする。cloud_web では、cc-connect がアダプターの WebSocket へ接続しにくる。アダプターは中継サーバーとして、サービス固有の部分だけを受け持つ。具体的には、受信と署名の検証、メンションの抽出、送信である。

Bridge は標準 platform ではないので、ADR 0001 に書いた制約を抱える。cloud_web は標準 platform なので、それらがない。

- 別の標準 platform を 1 つ置かないと起動しない。上流の issue #1438・#1516 は未解決のまま。
- 受け口が全インターフェースで開く。
- 送信者の許可も、重複の排除も、メンションの判定もない。

cloud_web は、送信者の許可（`allow_from`）、メンションがなければ反応しない設定（`group_reply_all = false`）、`msg_id` による重複の排除、再接続と ping を持つ。2026-11-07 にローカルで次を確かめた。

- cloud_web だけで起動した。アダプターが後から起動しても接続した。
- メンションのない発言と、許可していない送信者の発言を無視した。
- 同じ `msg_id` は 1 回だけ処理した。
- `share_session_in_channel = true` で、セッションがルーム単位になった。
- `name` の違う cloud_web を 2 つ並べ、セッションが分かれた。
- テキストでの実行承認が通った。

## Considered Options

- Bridge のまま進める。上流での実績は cloud_web より長い。cloud_web は追加以降、IPv6 のテスト修正が 1 件あるだけ。ただし、上に挙げた制約を回避するコードを、アダプター側で持ち続けることになる。

## Consequences

Bridge では実現できて、cloud_web では実現できないこと：

- 1 本の接続で、メッセージごとに複数のプロジェクトへ振り分けること。cloud_web の platform は 1 つのプロジェクトに属する。プロジェクトごとに cloud_web を並べ、アダプターが複数の接続を受ければ同じことができる。
- Bridge の REST によるセッション管理（`/bridge/sessions`）。ルームでの `/new`・`/list`・`/switch` か、cc-connect の管理 API で代わりになる。
- cc-connect の再起動直後に、ルームへ能動的に送ること（cron・timer・`cc-connect send`）。cloud_web は返信先をメモリにだけ持つので、再起動後、そのルームから 1 通届くまで送れない。アダプター側では回避できない。今の要件にはなく、cron なども無効にしている。必要になったら、本体へ PR を出す。
- 動画の送信。cloud_web はファイル送信に切り替える。LINE での動画送信は要件にない。
- コマンド一覧のスナップショットと、進捗表示の形式の通知（Bridge の metadata）。表示モードは quiet、出力はテキストだけなので使わない。
- 再接続の間隔を、アダプター側で決めること。cloud_web では cc-connect が再接続し、待ち時間は 2 秒から 30 秒まで倍々に延び、成功しても戻らない（実測で約 30 秒）。そのため、アダプターの再起動中に返事が失われうる。返事が失われた可能性をルームに知らせる処理で補う。

アダプター側で守ること：

- `register_ack` では `capabilities` を必ず明示する。省略すると、cc-connect はすべての機能に対応しているものとして扱う。
- token は URL のクエリにも載ってくる。リクエストの URL をログに出さない。
- 重複を除くのは 60 秒間だけ。LINE の再送に備え、`webhookEventId` でも重複を除く。
- 返事が失われる場合は、Bridge と同じく残る。切断中の送信は失われ、cc-connect はエラーを記録するだけ。
