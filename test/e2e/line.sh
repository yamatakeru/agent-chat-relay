#!/usr/bin/env bash
# 中継の e2e（LINE の API はモック）。引数：ハーネス名（claude か opencode。既定は claude）と --full。
# 既定では中核（ペアリング、返信、承認の許可・常に許可・拒否）を走らせる。--full を付けると、
# モデルの能力に頼る手順（別のルームへの投稿、画像の説明と返送）も走らせる（ADR 0023）。
# 各手順を判定し、1 つでも失敗すれば 0 以外で終わる。
# 実際のハーネスを動かすので、契約の利用枠を少し使う。記録と作業ディレクトリは .local/e2e/ に作る。
# Claude Code の会話ログ（~/.claude/projects/）は、終わるときに test/e2e/lib.sh が消す。
set -uo pipefail
. "$(dirname "$0")/lib.sh"

E=.local/e2e
LOG="$E/sent-line-$H.jsonl"
RLOG="$E/relay-line-$H.log"
mkdir -p "$E"
: >"$LOG"
# 前回の作業ディレクトリが残っていると、承認が不要な結果になる（ファイルがすでにある）ので、作り直す
rm -rf "$E/relay-line-$H"
# 作業ディレクトリが <RELAY_HOME>/workspace であることと、既定の設定の読み込みを前提に確かめるので、シェルに残った指定を外す
unset RELAY_WORKSPACE RELAY_HARNESS_SETTINGS RELAY_HARNESS_MEMORY
# モックの Webhook には X-Forwarded-Proto が付かないので、画像の公開 URL は固定で渡す
export RELAY_ENV_FILE="$E/.env" RELAY_HOME="$PWD/$E/relay-line-$H" RELAY_LINE_API_BASE=http://127.0.0.1:18099 \
  RELAY_LINE_CHANNEL_SECRET=dummysecret RELAY_LINE_CHANNEL_TOKEN=dummytoken RELAY_PUBLIC_URL=http://127.0.0.1:18080
G1=C111aaaaaaaaaaaaaaaaaaaaaaaaaaaaa
G2=C222bbbbbbbbbbbbbbbbbbbbbbbbbbbbb
A=Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

mise exec -- bun --no-env-file --config=/dev/null test/e2e/mock-line.ts "$LOG" >"$E/mock-line-$H.log" 2>&1 &
MOCK=$!
scripts/relay.sh serve "$H" >"$RLOG" 2>&1 &
RELAY=$!
for _ in $(seq 60); do
  grep -q "セッションを開始しました" "$RLOG" && break
  sleep 2
done
grep -q "セッションを開始しました" "$RLOG" || { echo "relay did not start"; tail -20 "$RLOG"; exit 1; }

wh() { scripts/relay.sh line-webhook "$@" >/dev/null; }

echo "== pairing"
check "ペアリング（開発チーム）" pair_after wh join "$G1"
check "ペアリング（承認者の DM）" pair_after wh text "$A" "$A" "hi"
check "ペアリング（営業チーム）" pair_after wh join "$G2"

echo "== reply in group"
n="$(lines)"; wh text "$G1" "$A" "自己紹介を一言で" --mention
check "ルームでの返信" waitfor "$n"

if [ "$FULL" = 1 ]; then
  echo "== cross-room post"
  n="$(lines)"; wh text "$G2" "$B" "開発チームのルームに『営業から連絡：明日10時に打ち合わせ』と投稿して、ここには一言で報告して" --mention
  waitfor "$((n + 1))"
  check_model "別のルームへの投稿" sent_after "$n" '"to":"C111".*打ち合わせ'

  echo "== image from someone else, then ask"
  wh image "$G1" "$B"; sleep 1
  n="$(lines)"; wh text "$G1" "$A" "さっきボブが送った画像の色を一語で教えて" --mention
  waitfor "$n" 120
  check_model "画像の説明（赤）" sent_after "$n" '赤'

  echo "== return the image"
  wh text "$G1" "$A" "さっきボブが送った画像を、そのままこのルームに返して" --mention
  # 0.1.1 の作業では、別のルームを見て見つけられないまま、待つ時間を使い切ることがあった。待つのは 2 分まで
  for _ in $(seq 120); do
    grep -q '"type":"image"' "$LOG" && break
    sleep 1
  done
  url="$(grep -o '"image":"[^"]*"' "$LOG" | tail -1 | cut -d'"' -f4)"
  echo "image url: ${url:-none}"
  media_ok() { [ -n "$url" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "$url")" = 200 ]; }
  check_model "画像の返送と、公開 URL からの取得" media_ok
fi

# 承認依頼の ID（文面の「yes <ID>」）のうち、まだ答えていないもの
answered=" "
new_approvals() {
  local id
  for id in $(grep -o 'yes [a-km-z]\{5\}' "$LOG" | awk '{print $2}'); do
    case "$answered" in *" $id "*) ;; *) echo "$id" ;; esac
  done
}
# ルームへの返事（承認依頼と、承認の答えへの返事を除く）の数
replies() { grep -v '"to":"Uaaa"' "$LOG" | grep -vc '"text":"✅\|"text":"❌'; }
# ルームに返事が来るまで、届いた承認依頼すべてに verdict で答える。答えた依頼を表示し、
# 答えた数を ASKED に、「常に許可」が示された数を OFFERED に入れる
answer_until_reply() {
  local verdict="$1" before id
  before="$(replies)"
  ASKED=0 OFFERED=0
  for _ in $(seq 200); do
    for id in $(new_approvals); do
      answered="$answered$id "
      ASKED=$((ASKED + 1))
      if grep -q "always $id" "$LOG"; then OFFERED=$((OFFERED + 1)); echo "approval $id: 常に許可あり"; else echo "approval $id: 常に許可なし"; fi
      echo "answer $verdict $id"
      wh postback "$A" "perm:$verdict:$id"
    done
    [ "$(replies)" -gt "$before" ] && return 0
    sleep 1
  done
  echo "timeout waiting for a reply"
  return 1
}
W="$RELAY_HOME/workspace"
asked() { [ "$ASKED" -gt 0 ]; }
offered() { [ "$OFFERED" -gt 0 ]; }
has() { grep -q -- "$2" "$W/$1" 2>/dev/null; }

echo "== approval (allow)"
wh text "$G1" "$A" "作業ディレクトリに note.txt を作って ok と書いて。終わったら一言で報告して" --mention
check "許可：返事が届く" answer_until_reply allow
check "許可：承認依頼が届く" asked
check "許可：ファイルができる" has note.txt ok

# 拒否のあとに頼むと、拒否を避ける別の手段とみなして実行しないことがある（Haiku で起きた）ので、拒否より先に確かめる
echo "== approval (always)"
wh text "$G1" "$A" "Bash で \`echo always >> always.txt\` を実行して。終わったら一言で報告して" --mention
check "常に許可：返事が届く" answer_until_reply always
check "常に許可：承認依頼が届く" asked
check "常に許可：「常に許可」が示される" offered
check "常に許可：コマンドが実行される" has always.txt always
# 常に許可すると、Claude Code がその範囲を作業ディレクトリの設定（.claude/settings.local.json）に足す。
# 同じコマンドを 2 回頼んで確かめる形にしないのは、エージェントがコマンドを書き足すと範囲から外れ、承認依頼が出るため
echo "-- settings.local.json"; cat "$W/.claude/settings.local.json" 2>/dev/null || echo "(なし)"
# エージェントは、cd を前に付けるなど、コマンドを組み立て直すことがあるので、範囲の先頭は決めない
[ "$H" = claude ] && check "常に許可：範囲が作業ディレクトリの設定に足される" has .claude/settings.local.json '"Bash(.*echo always'

echo "== approval (deny)"
wh text "$G1" "$A" "作業ディレクトリに denied.txt を作って ng と書いて。拒否されたら、ほかの方法は試さずに一言で報告して" --mention
check "拒否：返事が届く" answer_until_reply deny
check "拒否：承認依頼が届く" asked
check "拒否：ファイルができない" test ! -e "$W/denied.txt"

sleep 3
echo "== workspace"; ls "$W"
for f in note.txt denied.txt always.txt; do echo "-- $f"; cat "$W/$f" 2>/dev/null || echo "(なし)"; done
echo "== sent"; cat "$LOG"
echo "== relay log"; grep -E "ツール|実行承認|届いていない|失敗|error" "$RLOG" | cut -c1-260
finish
