---
status: accepted
---

# Discord は Gateway を discord.js で受け、スレッドは親のチャンネルの登録を引き継ぐ

Discord の接続部は、公式の Claude Code Discord プラグイン（`claude-plugins-official` の `external_plugins/discord`）を手本にする（2026-11-09）。Gateway（常時つなぐ WebSocket）で受け、REST で送る。どちらも discord.js（14.28.1）に任せる。ADR 0007 で TypeScript を選んだ理由の一つでもある。

## 決めたこと

- **受け方**：Gateway で受ける。Webhook もトンネルも要らない。discord.js が、再接続と REST の回数制限（道ごとの待ち）を受け持つ。
- **ルームの ID**：
  - チャンネルは `discord:c<ID>` で表す。
  - スレッドは `discord:c<親のチャンネル>/<スレッド>` で表す。
  - DM は、LINE と Chatwork と同じく、相手の ID（`discord:u<ID>`）をルームにする。
- **スレッド**：
  - スレッドは別のルームとして扱い、返事はスレッドへ返す。
  - 登録（受信モードと送信者の許可を含む）は、親のチャンネルから引き継ぐ。中核は「ID が `親/子` の形なら、親の登録を引く」とだけ決め、受信でも送信でも、ID だけで判定する。
  - 未登録のチャンネルのスレッドで話しかけられたら、スレッドに、親を登録するコードを返す。
  - 送信では、実際の親が ID の親と同じスレッドにだけ送る。登録したチャンネルの ID に、ほかのチャンネルのスレッドを付けて送ることを防ぐためである。
  - 公開スレッドは、Bot が参加しなくても受け取れる。公式資料（`developers/topics/threads.mdx`）に「Upon connecting to the Gateway, apps will be automatically subscribed to thread events and active threads.」とある。非公開スレッドは、Bot を招待したときだけ受け取れる。
- **メンション**：Bot への `@`、Bot 専用のロールへの `@`、Bot の発言への返信を数える。`@everyone`・`@here`・ほかのロールは数えない（GLOSSARY）。プラグインは discord.js の既定の判定を使うので、`@everyone` も数えてしまう。
- **サーバーへの追加**：Bot がサーバーに追加されても、コードは投稿しない。追加先はサーバーで、どのチャンネルを登録したいのか分からない。登録したいチャンネルで話しかけると、コードが返る。
- **Bot と Webhook の発言は受けない**：Bot どうしで応答し続けるのを防ぐ（プラグインと同じ）。履歴には含まれる。
- **`fetch_messages`**：Discord の履歴を読む。Gateway は、止まっている間の発言を後から送らない。それでも、履歴から読める。
- **送信**：
  - 本文は 1 通 2000 字で、超えたら 10 通まで分けて送る。
  - ファイルは種類を問わず、1 個 10MB・1 回 10 個までと申告する。今の既定は 10MiB で、サーバーのブーストで上がる。プラグインにある 25MB は古い値である。
  - エージェントの本文では、`@everyone`・`@here` やロールの通知を鳴らさない（`allowedMentions`）。プロンプトインジェクションで、大勢に通知を鳴らされるのを防ぐ。
- **実行承認**：承認者の DM に、許可・拒否のボタンを付けて送る。`yes <ID>`・`no <ID>` の文字でも答えられる。押したら、ボタンを外して結果を書き足す。
- **確かめ方**：discord.js のイベントを偽の Client で流す単体テストと、実際の Discord で確かめる。Gateway のモックは作らない。作る手間が大きく、Discord は無料で、送信の通数の制約もない。

## Considered Options

- **スレッドの親を、接続部に尋ねる**（ID はスレッドだけにする）。ID は短い。ただ、送信できるかの判定が非同期になり、中核と接続部の取り決めが増える。
- **スレッドごとに登録する**。中核は今のままで済む。ただ、スレッドを作るたびに管理者の操作が要る。
- **Gateway のモックで e2e を作る**。LINE・Chatwork と同じ形で全体を流せる。ただ、作るのに手間がかかる。

## Consequences

- 中核の `access.ts` に `registrationOf`（ID の `/` より前）を足した。ほかのサービスの入れ子の場（あれば）にも使える。
- 依存に discord.js が加わる。
- Discord Developer Portal で、Message Content の特権インテントをオンにする必要がある。Bot が 1 万ユーザー未満の範囲にいるあいだは、審査は要らない（2026-06 の変更）。
- 止まっている間の発言は、記録にも残らない。`fetch_messages` で Discord の履歴から読む。
