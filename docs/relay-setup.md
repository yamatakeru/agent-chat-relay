# 中継の動かし方

仕様は `docs/relay.md` にある。ここでは、手元の Mac で動かす手順と、確かめる項目を書く。

## LINE 公式アカウントとチャネルの準備（初回だけ）

Messaging API のチャネルは、LINE Developers コンソールで直接は作れない。LINE 公式アカウントを作り、LINE Official Account Manager（以下 OAM）で Messaging API を有効にすると、チャネルができる。画面の名称は変わることがあるので、見つからないときは近い名前の項目を探す。

1. **公式アカウントを作る**：<https://entry.line.biz/start/jp/> から、LINE ビジネス ID（個人の LINE アカウントでよい）でログインして作る。アカウント名はグループのメンバーに表示される名前で、あとから変えられる。無料のコミュニケーションプランで始まり、認証済みアカウントの申請は要らない。
2. **Messaging API を有効にする**（OAM の Web 版でだけ操作できる）：<https://manager.line.biz/> で、［設定］→［Messaging API］→［Messaging API を利用する］。プロバイダーは新しく作る。**プロバイダーはあとから変えられない**ので、仕事で使っている既存のものは選ばない。プライバシーポリシーと利用規約の URL は空欄でよい。
3. **応答設定**（OAM の［設定］→［応答設定］）：チャット・あいさつメッセージ・応答メッセージをオフにする。手動のチャットや自動の応答が、Bot の返事に混ざらないようにするため。Webhook は、URL を登録するまでオンにできない。
4. **グループへの参加を許可する**（OAM の［設定］→［アカウント設定］→［トークへの参加］）：既定では許可されていない。1 つのグループに参加できる公式アカウントは 1 つだけ。
5. **値を控える**（<https://developers.line.biz/console/> で、作ったプロバイダーのチャネルを開く）
   - ［チャネル基本設定］の**チャネルシークレット**と、［Messaging API 設定］の**チャネルアクセストークン（長期）**（［発行］を押す）を、`scripts/relay.sh secrets` で保存する。チャットに貼らない。OAM の［設定］→［Messaging API］にはシークレットが平文で出るので、その画面のスクリーンショットを共有しない。漏れたら再発行して、保存し直す。トークンを再発行すると、前のものは使えなくなる。
   - ［Messaging API 設定］の QR コードは、Bot を友だちに追加するときに使う。

## Chatwork の Bot アカウントの準備（初回だけ）

1. **Bot 用の Chatwork アカウントを作る**（無料プランでよい）。表示名は、ルームのメンバーに見える Bot の名前になる。自分のアカウントは使わない。Bot の発言が自分の名前で出て、自分へのメンションがすべて Bot に渡ってしまうため。
2. **API トークンを発行する**：Bot のアカウントでログインし、右上のメニュー →［サービス連携］→［API トークン］。組織の契約によっては、組織管理者への申請が要る。トークンは `scripts/relay.sh secrets chatwork` で保存する。チャットに貼らない。漏れたら再発行して、保存し直す。
3. **コンタクトになる**：使う人と Bot をコンタクトにする。DM と実行承認の依頼は、コンタクトとのダイレクトチャットでやりとりする。無料プランでは、組織外のコンタクトは 1 ユーザーあたり 20 人まで。
4. Webhook とトンネルは要らない（ADR 0010）。

## Discord の Bot の準備（初回だけ）

1. **アプリを作る**：<https://discord.com/developers/applications> で［New Application］。名前は、サーバーのメンバーに見える Bot の名前になる。
2. **Bot のトークン**：［Bot］→［Reset Token］で表示されたトークンを、`scripts/relay.sh secrets discord` で保存する。チャットに貼らない。漏れたら作り直して、保存し直す。
3. **Message Content Intent をオンにする**：同じ［Bot］の画面の［Privileged Gateway Intents］で、［Message Content Intent］をオンにする。オフだと、メンションのない発言の本文が空で届く。
4. **サーバーに招待する**：［OAuth2］→［URL Generator］で、Scopes に `bot` を選ぶ。Bot Permissions には次を選ぶ。
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Read Message History
   - Attach Files
   - Add Reactions

   作られた URL を開き、使うサーバーを選ぶ。
5. Webhook とトンネルは要らない（ADR 0011）。非公開スレッドで使うときは、そのスレッドに Bot を招待する。

## 用意

- `mise install` と `mise exec -- bun install`。Agent SDK に同梱の Claude CLI（約 320MB）は入れない（`bunfig.toml`）。
- Claude Code（`claude`）がインストールされ、ログインしていること。中継は、このコマンドを `claude-agent-acp` 経由で動かす。
- 秘密情報：LINE は `scripts/relay.sh secrets line`、Chatwork は `scripts/relay.sh secrets chatwork`、Discord は `scripts/relay.sh secrets discord` で入力する。1 つだけでも動く。

| 場所 | 中身 |
|---|---|
| `.env`（git の無視対象） | `RELAY_LINE_CHANNEL_SECRET`・`RELAY_LINE_CHANNEL_TOKEN`・`RELAY_CHATWORK_API_TOKEN`・`RELAY_DISCORD_BOT_TOKEN`（dotenvx で暗号化） |
| `.local/relay/access.json` | ルームの登録・許可リスト・ペアリング待ちのコード |
| `.local/relay/workspace/` | セッションの作業場所。受け取った添付は `.relay/inbox/` に置き、7 日で消す |
| `.local/relay/media/` | LINE へ返した画像（推測できない名前で公開する。7 日で消す） |
| `.local/relay/harness.log` | ハーネスが stderr に出したもの（画面には出さない。異常終了したときだけ、最後の 20 行を画面に出す）。10MB を超えそうになったら `harness.log.1` に移して新しく始める |

## 起動

ターミナルを 2 つ使う。

1. `scripts/relay.sh serve`（ハーネスは Claude Code）。OpenCode は実行承認が働かないため（#6）、`RELAY_ALLOW_UNSAFE_HARNESS=1` を付けない限り起動しない。試すときも、信頼できる人だけのルームに限る
   - 起動のたびに新しいセッションになる。前の会話を続けるときは、前回の起動ログの「セッションを開始しました」（または「再開しました」）にある `sessionId` を渡す：`scripts/relay.sh serve --session-id <id>`。再開できなければ、理由を出して起動しない（新しくは作らない）。再開できるのは、中継の作業場所で作ったセッションだけ（`docs/relay.md`）
2. `scripts/relay.sh line-tunnel`。表示された `https://….trycloudflare.com` の末尾に `/line/webhook` を付けて、LINE Developers コンソールの［Messaging API 設定］の Webhook URL に登録し、［検証］を押す。

   | ［検証］の結果 | 主な原因 |
   |---|---|
   | 401 | チャネルシークレットの誤り。`secrets` で入れ直す |
   | 404 | URL の末尾の `/line/webhook` がない |
   | 502・530 など | 中継が動いていない、またはトンネルの URL が古い |

3. ［Webhook の利用］をオンにする。オフだと、検証が通っても発言は届かない。［Webhook の再送］はオフのまま（既定）にする。再送された依頼の扱いは、まだ決めていない（`docs/relay.md`）。

Quick Tunnel の URL は、トンネルを起動し直すたびに変わる。そのたびに Webhook URL を登録し直す。URL が古いままだと、発言は届かずに失われる。中継だけを再起動するときは、URL は変わらない。

止めるときは、両方を Ctrl+C で止め、［Webhook の利用］をオフにする。

Chatwork と Discord だけで使うときは、`scripts/relay.sh serve` だけでよい（トンネルは要らない）。

## ルームと承認者の登録（ペアリング）

1. Bot に 1 対 1 で何か送る。コードが返るので、端末で `scripts/relay.sh pair <コード>` を実行する。これで、自分が許可リストに入り、実行承認の依頼を受け取れるようになる。
2. Bot をグループに招待する（招待済みなら、Bot にメンションして何か送る）。コードが返るので、同じく `pair` する。
3. `scripts/relay.sh access` で、登録したものを確かめられる（ID は伏せて表示する）。

## 確かめる項目（LINE）

| すること | 期待する結果 |
|---|---|
| 登録していないグループで、Bot にメンションする | コードが返る（Reply なので通数を使わない） |
| 登録したグループで、Bot にメンションして質問する | 返事が届く |
| メンションせずに発言する | 返事はない |
| グループ A で「グループ B に〜と投稿して」と頼む | B に投稿され（Push）、A に報告が届く |
| 画像を送ってから、メンションして「さっきの画像を説明して」 | 画像を見た答えが届く |
| メンションして「さっきの画像をそのまま返して」 | 画像が届く。開くと元の大きさで見られる |
| メンションして、作業場所にファイルを作るよう頼む | 承認者の DM に承認依頼が届く。［許可］で実行され、返事が届く |
| 承認依頼に［拒否］で答える | 実行されない |

Push は、グループでは人数分、承認依頼は承認者 1 人につき 1 通を使う。今月の消費は `scripts/relay.sh line-quota` で分かる。

## 確かめる項目（Chatwork）

| すること | 期待する結果 |
|---|---|
| Bot を新しいグループチャットに追加する | 数秒でコードが投稿される |
| 登録したルームで、Bot に To を付けて質問する | 返事が届く（数秒遅れる） |
| To を付けずに発言する | 返事はない。あとで「さっきの発言は？」と聞くと読める |
| 中継を止めている間に To を付けて依頼し、起動する | 実行されない |
| ファイルを送ってから、「さっきのファイルを要約して」 | 中身を読んだ答えが届く |
| 「〜を CSV にして送って」 | 作業場所に作る承認依頼が DM に届き、`yes <ID>` で許可するとファイルが届く |

## 確かめる項目（Discord）

| すること | 期待する結果 |
|---|---|
| Bot に DM を送る | コードが返り、`pair` すると許可リストに入る |
| チャンネルで Bot に `@` を付けて話しかける | コードが返る。`pair` すると、そのチャンネルが登録される |
| 登録したチャンネルで、Bot に `@` を付けて質問する | 入力中の表示が出て、返事が届く |
| Bot の発言に返信する／`@everyone` で発言する | 返信には返事が届く。`@everyone` には反応しない |
| 登録したチャンネルでスレッドを作り、Bot に `@` を付けて話しかける | 登録なしで、スレッドに返事が届く |
| 未登録のチャンネルのスレッドで話しかける | スレッドにコードが返り、`pair` すると親のチャンネルが登録される |
| 中継を止めている間に発言し、起動してから「さっきの発言は？」と聞く | Discord の履歴から読んで答える |
| 画像を送ってから、「さっきの画像を説明して」 | 中身を読んだ答えが届く |
| 「〜を CSV にして送って」 | 作業場所に作る承認依頼が、ボタン付きで DM に届く。［許可］を押すとファイルが届く |
| 2000 字を超える答えになる質問 | 分けて届く |

## モックでの確認

e2e のスクリプトは、チャットサービスごとに `test/e2e/<サービス>.sh` に置く（モックは `mock-<サービス>.ts`）。Discord は e2e を作らず、偽の Client（`test/fixtures/discord-fake.ts`）を使う単体テストと、実際の Discord で確かめる（ADR 0011）。

- `test/e2e/chatwork.sh claude`：Chatwork の API をモックにして流す（ペアリング、返事、画像の説明、停止中に届いた依頼、承認とファイルの返送、ルームへの追加）。
- `test/e2e/line.sh claude`：LINE の API をモックにして、上の項目のうち主なものを流す（ペアリング、返事、別のルームへの投稿、画像の説明と返送、承認）。
- `test/e2e/resume.sh claude`：LINE の API をモックにして、セッションの再開を流す（合言葉を覚えさせて止め、`--session-id` で再開して合言葉・返事・承認を確かめる。未知の ID では起動しないこと）。

どれも実際のハーネスを動かすので、契約の利用枠を少し使う。記録と作業場所は `.local/e2e/` に、サービスの名前を付けて残る（例：`relay-line-claude/`）。終わったら、Claude Code の会話ログ（`~/.claude/projects/` の `local-e2e` を含むもの）を消す。

開発中に Webhook を 1 つずつ送るときは、`scripts/relay.sh line-webhook text <ルーム> <ユーザー> <本文> [--mention]` などを使う（`scripts/line-webhook.ts`）。
