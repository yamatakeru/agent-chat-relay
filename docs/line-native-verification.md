# 段階 1：cc-connect 標準の LINE platform で実測する

cc-connect 1.5.0 標準の LINE platform を手元の Mac で動かし、実際の LINE グループで検証項目 1〜6 を確かめる手順。コードは書かない。結果は、自作の LINE アダプター（ADR 0001）で何を補うかを決める材料にする。

## 構成

```text
LINE ──HTTPS──> Cloudflare Quick Tunnel ──> localhost:18080/callback ──> cc-connect ──> Claude Code
  ^                                                                         |
  └─────────────────── Push API（返信）─────────────────────────────────────┘
```

| 置き場所 | 内容 |
|---|---|
| `examples/line-native/config.toml` | 設定例。秘密情報と userId は含まない |
| `scripts/line-native.sh` | 秘密情報の保存、起動、テスト用 Webhook の送信、通数の確認 |
| macOS キーチェーン | チャネルシークレット、チャネルアクセストークン |
| `~/.cc-connect-jtc/line-native/` | 実行時の設定の複製、`env`（許可する userId）、`data/`（セッション）、`workspace/`（Claude の作業場所） |

秘密情報と userId は、リポジトリ（public）・issue・チャットに書かない。

## 1. ツールの導入

cc-connect はリポジトリの `mise.toml` で 1.5.0 に固定している。cloudflared は自分で入れる。`-g` を付けずに実行すると、このリポジトリの `mise.toml` に版が記録され、インストールまで行われる。

```sh
cd ~/WorkSpace/develop/cc-connect-jtc-adapters
mise use cloudflared@2026.10.7
```

## 2. LINE 公式アカウントとチャネルの準備

2024 年 9 月以降、Messaging API チャネルは LINE Developers コンソールで直接作れない。LINE 公式アカウントを作り、LINE Official Account Manager で Messaging API を有効にする。画面の名称は変わることがある。

1. 検証専用の LINE 公式アカウントを作る（無料のコミュニケーションプラン）。
2. LINE Official Account Manager で Messaging API を有効にする。プロバイダーは後から変更できないため、検証用のプロバイダーを選ぶ。
3. LINE Official Account Manager の応答設定で、次のとおりにする。
   - 応答メッセージ：オフ
   - あいさつメッセージ：オフ
   - Webhook：オン
4. LINE Official Account Manager のアカウント設定で、グループ・複数人チャットへの参加を許可する。
5. LINE Developers コンソールで、次の値を控える。チャットには貼らない。
   - ［チャネル基本設定］タブ：チャネルシークレット
   - ［Messaging API 設定］タブ：チャネルアクセストークン（長期）。発行する
6. ［Messaging API 設定］タブの「Webhook の再送」はオフのままにする。停止中に届いた依頼は処理しない方針のため。

## 3. 秘密情報をキーチェーンへ保存

```sh
scripts/line-native.sh secrets
```

入力内容は画面に表示されない。値を更新するときも、同じコマンドを実行する。

## 4. 起動と Webhook の登録

ターミナルを 2 つ使う。

```sh
# ターミナル A：最初は debug ログで起動し、userId を確認する
CCJ_LOG_LEVEL=debug scripts/line-native.sh run

# ターミナル B
scripts/line-native.sh tunnel
```

1. ターミナル B に出る `https://<ランダム>.trycloudflare.com` を控える。
2. LINE Developers コンソールの［Messaging API 設定］で、Webhook URL を `https://<ランダム>.trycloudflare.com/callback` にして［更新］をクリックし、続けて［検証］をクリックする。「成功」と出ればよい。
3. ［Webhook の利用］をオンにする。

Quick Tunnel の URL は、tunnel を起動し直すたびに変わる。そのたびに、手順 2 をやり直す。cc-connect だけを再起動するときは、URL は変わらない。

止めるときは、それぞれのターミナルで Ctrl-C を押す。

## 5. 許可する userId の登録

最初の `env` には誰にも一致しない値を入れてある。そのため、この時点では誰の発言にも応答しない。

1. 検証メンバー（自分を含む 2〜3 人）が、Bot を友だちに追加し、1 対 1 トークで何か送る。
2. ターミナル A のログに、`line: message from unauthorized user user=U...` が出る。
3. `~/.cc-connect-jtc/line-native/env` を次の形に書き換える。

   ```sh
   CCJ_LINE_ALLOW_FROM=Uxxxxxxxx,Uyyyyyyyy
   ```

4. ターミナル A で cc-connect を再起動する。Ctrl-C で止め、`scripts/line-native.sh run` を実行する。debug ログには発言の内容も出るので、userId を取得した後は info に戻してよい。
5. 検証メンバーと Bot で LINE グループを作る。必要なら、比較用のグループをもう 1 つ作る。

## 6. 通数の目安

- グループへの Push は、メンバーの人数分の通数になる。無料プランの上限は月 200 通。
- 2 人のグループなら Bot の発言 100 回、3 人なら約 66 回で上限に届く。
- 表示モードは quiet にしているが、1 回の依頼で、承認依頼・承認結果・回答など複数の発言が出ることがある。
- 今月の消費量は `scripts/line-native.sh quota` で確認できる。

## 7. 検証項目と手順

結果は、末尾の記録欄と統括 issue #1 に残す。

| # | 確かめること | 手順 | 標準 platform で予想される結果 |
|---|---|---|---|
| 1 | 正しいルームで受信し、そこへ返信する | グループ G1 で依頼する。1 対 1 トークでも依頼する | それぞれ同じルームに返答する |
| 2 | 別のルームの会話が混ざらない | G1 で「合言葉は『りんご』。覚えておいて」と送る。1 対 1 トーク（または G2）で「合言葉は？」と聞く | 1 対 1 トーク側は合言葉を知らない |
| 3 | 会話の継続と、再起動後の扱い | G1 で「さっきの合言葉は？」と聞く。cc-connect を再起動してから、もう一度聞く。停止中に G1 へ依頼を送り、再起動後の挙動を見る | 再起動後も合言葉を覚えている。停止中の依頼は処理されない |
| 4a | 不正な署名 | `scripts/line-native.sh webhook <groupId> <userId> "test" --bad-signature` | HTTP 400。処理されない |
| 4b | 許可していない送信者 | 許可リストにない人が G1 で発言する（いなければ自分を一時的に外す） | 無視される。debug ログにだけ出る |
| 5a | 自己返信によるループ | 1〜3 の間、Bot の返信が新しい依頼として処理されていないことをログで確認する | ループしない。LINE は Bot 自身の発言を Webhook で送らない |
| 5b | 重複して受信したとき | `scripts/line-native.sh webhook <groupId> <自分の userId> "今の時刻を答えて" 2` | **2 回処理されると予想**。標準 platform には重複排除がない |
| 5c | 処理中に切断したとき | 長めの依頼の処理中に、(1) tunnel を止める、(2) cc-connect を止める | (1) 返信は届く（Push は外向きの通信）。(2) 返信は失われ、再起動後も再開しない |
| 5d | グループの全発言への反応 | G1 で Bot と関係のない雑談をする | **すべてに反応すると予想**。本番ではメンションされたときだけにする |
| 6 | 実行承認 | G1 で「workspace に hello.txt を作って」と送る。表示された承認依頼に、別のメンバーが `allow` と返す。別の依頼で `deny` も試す。承認待ちの間に関係ない発言もしてみる | 承認依頼がテキストで届き、ルームの誰でも承認できる。承認待ちの間の発言には案内が返る |

5b の `<groupId>` は、ログの `session=line:C...` から取得する。この手順の返信は実際の G1 に Push で届くので、通数を消費する。

## 設定の意図

- `cmd = "claude --setting-sources project,local"`：`~/.claude/settings.json` の allow ルール（例：`Bash(find:*)` や `Bash(uv:*)`。どちらも任意のコードを実行できる）を、グループからの依頼で承認なしに使わせないため。
- `disabled_commands`：`/mode` や `/allow` のように実行承認を迂回できるコマンドと、設定を変えるコマンドを無効にする。
- `admin_from` を設定しない：`/shell` や `/dir` などの特権コマンドは、誰も使えない。
- `reply_footer = false`：作業ディレクトリの絶対パスなどを、ルームに出さないため。

## 手元で確認済みのこと（ダミーの値、実際の LINE とは未接続）

- 設定がすべて読み込まれ、LINE の受信口が `:18080/callback` で起動する。
- 署名が不正な Webhook は 400 で拒否される。
- 許可していない送信者の発言は無視され、debug ログに userId が出る。
- 許可した送信者の依頼で Claude Code が `--setting-sources project,local` 付きで起動し、回答まで進む。返信は、ダミーのトークンなので 401 で失敗する。
- `CCJ_LINE_ALLOW_FROM` が空または `*` のときは、起動を拒否する。

## 実装を読んで分かった注意点

- 受信口のポートが使用中でも、cc-connect はエラーログを出すだけで「platform ready」と表示し、動き続ける。起動ログの `line: server error` に注意する。
- npm 版の `cc-connect` コマンドは Node のランチャーで、SIGTERM を Go の本体に転送しない。そのため `scripts/line-native.sh run` は本体を直接起動している。

## 記録

（実測した日付と結果を書く）
