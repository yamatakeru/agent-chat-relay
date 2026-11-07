# LINE アダプターの動かし方（段階 2）

自作の LINE アダプターと cc-connect 1.5.0 を cloud_web でつなぎ、LINE のグループから Claude Code に依頼する。振る舞いの仕様は `docs/line-adapter.md`、つなぎ方は ADR 0003・0004 にある。

LINE チャネルの作成、秘密情報の保存（`.env`）、userId の登録は、段階 1 と共通。まだなら `docs/line-native-verification.md` の 1〜3 節と 5 節に従う。`scripts/line-native.sh` の代わりに `scripts/line.sh` を使ってもよい。

## 構成

| 場所 | 内容 |
|---|---|
| `cmd/line`, `internal/` | アダプター（Go） |
| `examples/line/config.toml` | cc-connect の設定（multi-workspace モード、cloud_web） |
| `scripts/line.sh` | 起動・登録・テスト用の補助 |
| `.local/line/`（git の無視対象） | `data/`（cc-connect のセッションと作業場所の割り当て）、`workspaces/`（ルームごとの作業場所）、`rooms.json`（ルームの登録） |

アダプターは、`127.0.0.1:18080` で LINE の Webhook を、`127.0.0.1:18090` で cc-connect からの接続を待つ。外へ公開するのは Webhook だけで、Cloudflare Quick Tunnel を通す。

## 1. LINE Developers コンソールの設定

［Messaging API 設定］タブで、［Webhook の再送］をオンにする。アダプターが止まっている間に届いた依頼を、再送されたときに「停止中に届いたため処理していない」と知らせるため。依頼は実行しない。

## 2. 起動

ターミナルを 3 つ使う。

```sh
# ターミナル A：アダプター
scripts/line.sh adapter
# ターミナル B：cc-connect
scripts/line.sh cc
# ターミナル C：Quick Tunnel
scripts/line.sh tunnel
```

- 初回の起動時に、cc-connect とアダプターの間の token を作り、`.env` に暗号化して保存する。
- アダプターと cc-connect は、どちらを先に起動してもよい。cc-connect は、つながるまで接続を試み直す（間隔は最大 30 秒）。
- ターミナル C に出た URL の末尾に `/callback` を付け、Webhook URL に登録する（段階 1 と同じ手順）。

## 3. グループの登録

1. LINE で、検証メンバーと Bot のグループを作る。
2. Bot は、このグループが未登録であることを一度だけ返事する。ターミナル A に `line: joined unregistered group group=C…` が出る。
3. `scripts/line.sh room add C…` で登録する。再起動は要らない。全員の発言を受け取るときは、`scripts/line.sh room add C… all` とする。

許可した人との 1 対 1 トークは、登録しなくても使える。

## 4. 確かめること

`docs/line-adapter.md` の振る舞いを、実際の LINE で確かめる。

| 確かめること | 期待する結果 |
|---|---|
| メンションのない発言 | 反応しない |
| Bot にメンションした依頼 | 返事が来る。すぐ答えられる依頼なら Reply（通数を使わない） |
| 書き込みを伴う依頼 | 承認依頼が来る。`allow all` の選択肢は表示されない |
| メンションなしの `許可` / `allow` | 承認され、続きの答えが来る。「✅ 許可しました」は出ない |
| 承認待ちでの `allow all` | 「このルームでは allow all は使えません」と返る |
| 別のグループや 1 対 1 トーク | 会話も作業場所のファイルも混ざらない |
| cc-connect を止めて依頼 | 「いまは停止中」と返る |
| 処理中に cc-connect を止める | 「返事が届かなかった可能性があります」と知らせる |

## ローカルでの確認（実際の LINE を使わない）

`CCJ_LINE_API_BASE` に LINE の API のモックを指定すると、送信をモックへ向けられる。`scripts/line.sh webhook` で、署名付きの Webhook をアダプターへ送れる。

```sh
scripts/line.sh webhook <groupId> <userId> "依頼" --mention        # グループでメンション
scripts/line.sh webhook - <userId> "依頼"                          # 1 対 1 トーク
scripts/line.sh webhook <groupId> <userId> "依頼" --mention 2      # 同じ Webhook を 2 回（重複）
scripts/line.sh webhook <groupId> <userId> "依頼" --redelivery     # 再送
```

ダミーの値で試すときは、`CCJ_ENV_FILE` に存在しないファイルを指定し、秘密情報を環境変数で渡す。テストで Claude Code を起動すると、`~/.claude/projects/` に会話ログができるので、終わったら片付ける。

## 記録

### 2026-11-07（cc-connect 1.5.0、Claude Code 2.1.318、PR #2）

モックで確かめた結果（LINE の API のモック、`scripts/line.sh webhook`、実際の cc-connect と Claude Code）：

- 署名の誤り、メンションのない発言、許可していない人、未登録のグループは渡さなかった。同じ Webhook を 2 回送っても 1 回だけ処理した
- ルームごとに作業場所・会話・Claude の会話ログが分かれた。割り当ての追加に再起動は要らなかった（ADR 0004）
- 承認依頼に `allow all` は出ず、承認待ちの `allow all` は断り、メンションなしの `許可` で承認できた。承認待ちの間の承認以外の発言は保留し、待ちが終わってから渡した
- 再送、停止中、切断のそれぞれで案内が届いた。cc-connect とアダプターのどちらを再起動しても、つながり直した

実際の LINE で確かめた結果（検証メンバー 2 人のグループ、許可したのは 1 人。4 節の表の順）：

| 確かめること | 結果 |
|---|---|
| メンションのない発言 | 反応しなかった |
| Bot にメンションした依頼 | 返事が Reply で届いた |
| 書き込みを伴う依頼 | 承認依頼が届いた。`allow all` の選択肢は出なかった |
| メンションなしの `許可` | 承認され、続きの答えが届いた。「✅ 許可しました」は出なかった |
| 承認待ちでの `allow all` | 初回は、メンションなしの `allow all` に何も返さなかった（承認は切り替わっておらず、安全側）。メンションなしでも断るよう直し、確かめ直した |
| 1 対 1 トーク | グループで作ったファイルは見えなかった |
| cc-connect を止めて依頼 | 「いまは停止中」と返った |
| 処理中に cc-connect を止める | 「返事が届かなかった可能性があります」と届いた |

段階 2 の検証で消費した通数は 0 通（段階 1 からの累計は、月 200 通のうち 31 通のまま）。今回の返事と案内は、すべて Reply で届いた。

未確認：許可したメンバーが複数いるときの承認、受信モード「すべて」、長い答えの分割、通数の上限に達したときの案内、Webhook の再送（アダプターを止めている間の依頼）。
