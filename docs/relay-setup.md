# 中継の動かし方

仕様は `docs/relay.md` にある。ここでは、手元の Mac で動かす手順と、確かめる項目を書く。

## 用意

- `mise install` と `mise exec -- bun install`。Agent SDK に同梱の Claude CLI（約 320MB）は入れない（`bunfig.toml`）。
- Claude Code（`claude`）がインストールされ、ログインしていること。中継は、このコマンドを `claude-agent-acp` 経由で動かす。
- LINE の秘密情報：`scripts/relay.sh secrets` で入力する。旧構成の値があるなら、`scripts/relay.sh migrate-secrets` で写せる。

| 場所 | 中身 |
|---|---|
| `.env`（git の無視対象） | `RELAY_LINE_CHANNEL_SECRET`・`RELAY_LINE_CHANNEL_TOKEN`（dotenvx で暗号化） |
| `.local/relay/access.json` | ルームの登録・許可リスト・ペアリング待ちのコード |
| `.local/relay/workspace/` | セッションの作業場所。受け取った添付は `.relay/inbox/` に置く |

## 起動

ターミナルを 2 つ使う。

1. `scripts/relay.sh serve`（ハーネスは Claude Code。`serve opencode` で OpenCode）
2. `scripts/relay.sh tunnel`。表示された `https://….trycloudflare.com` の末尾に `/line/webhook` を付けて、LINE Developers コンソールの Webhook URL に登録し、［検証］を押す。旧構成の `/callback` からパスが変わった。

止めるときは、両方を Ctrl+C で止め、［Webhook の利用］をオフにする。

## ルームと承認者の登録（ペアリング）

1. Bot に 1 対 1 で何か送る。コードが返るので、端末で `scripts/relay.sh pair <コード>` を実行する。これで、自分が許可リストに入り、実行承認の依頼を受け取れるようになる。
2. Bot をグループに招待する（招待済みなら、Bot にメンションして何か送る）。コードが返るので、同じく `pair` する。
3. `scripts/relay.sh access` で、登録したものを確かめられる（ID は伏せて表示する）。

## 確かめる項目

| すること | 期待する結果 |
|---|---|
| 登録していないグループで、Bot にメンションする | コードが返る（Reply なので通数を使わない） |
| 登録したグループで、Bot にメンションして質問する | 返事が届く |
| メンションせずに発言する | 返事はない |
| グループ A で「グループ B に〜と投稿して」と頼む | B に投稿され（Push）、A に報告が届く |
| 画像を送ってから、メンションして「さっきの画像を説明して」 | 画像を見た答えが届く |
| メンションして、作業場所にファイルを作るよう頼む | 承認者の DM に承認依頼が届く。［許可］で実行され、返事が届く |
| 承認依頼に［拒否］で答える | 実行されない |

Push は、グループでは人数分、承認依頼は承認者 1 人につき 1 通を使う。今月の消費は `scripts/relay.sh quota` で分かる。

## モックでの確認

`test/e2e/run.sh claude` で、LINE の API をモックにして、上の項目のうち主なものを流す（ペアリング、返事、別のルームへの投稿、画像、承認）。実際のハーネスを動かすので、契約の利用枠を少し使う。記録は `.local/e2e/` に残る。終わったら、Claude Code の会話ログ（`~/.claude/projects/` の `local-e2e` を含むもの）を消す。

開発中に Webhook を 1 つずつ送るときは、`scripts/relay.sh webhook text <ルーム> <ユーザー> <本文> [--mention]` などを使う（`scripts/webhook.ts`）。
