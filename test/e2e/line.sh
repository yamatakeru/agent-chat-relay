#!/usr/bin/env bash
# 中継の e2e（LINE の API はモック）。引数：ハーネス名（claude か opencode）。
# 実際のハーネスを動かすので、契約の利用枠を少し使う。記録と作業ディレクトリは .local/e2e/ に作る。
# 終わったら、ハーネスの会話ログ（Claude Code なら ~/.claude/projects/ の .local-e2e を含むもの）を消す。
set -uo pipefail

H="$1"
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
cleanup() { kill "$RELAY" "$MOCK" 2>/dev/null; }
trap cleanup EXIT
for _ in $(seq 60); do
  grep -q "セッションを開始しました" "$RLOG" && break
  sleep 2
done
grep -q "セッションを開始しました" "$RLOG" || { echo "relay did not start"; tail -20 "$RLOG"; exit 1; }

wh() { scripts/relay.sh line-webhook "$@" >/dev/null; }
lines() { wc -l <"$LOG" | tr -d ' '; }
# 送信の記録が n 行を超えるまで待つ
waitfor() {
  local n="$1" t="${2:-150}"
  for _ in $(seq "$t"); do
    [ "$(lines)" -gt "$n" ] && return 0
    sleep 1
  done
  echo "timeout waiting > $n"
  return 1
}
code() { grep -o 'relay pair [0-9a-f]\{6\}' "$LOG" | tail -1 | awk '{print $3}'; }
pair_after() { local n; n="$(lines)"; wh "$@"; waitfor "$n" 10; scripts/relay.sh pair "$(code)"; }

echo "== pairing"
pair_after join "$G1"
pair_after text "$A" "$A" "hi"
pair_after join "$G2"

echo "== reply in group"
n="$(lines)"; wh text "$G1" "$A" "自己紹介を一言で" --mention; waitfor "$n"

echo "== cross-room post"
n="$(lines)"; wh text "$G2" "$B" "開発チームのルームに『営業から連絡：明日10時に打ち合わせ』と投稿して、ここには一言で報告して" --mention; waitfor "$((n + 1))"

echo "== image from someone else, then ask"
wh image "$G1" "$B"; sleep 1
n="$(lines)"; wh text "$G1" "$A" "さっきボブが送った画像の色を一語で教えて" --mention; waitfor "$n" 200

echo "== return the image"
wh text "$G1" "$A" "さっきボブが送った画像を、そのままこのルームに返して" --mention
for _ in $(seq 200); do
  grep -q '"type":"image"' "$LOG" && break
  sleep 1
done
url="$(grep -o '"image":"[^"]*"' "$LOG" | tail -1 | cut -d'"' -f4)"
echo "image url: ${url:-none}"
[ -n "$url" ] && curl -s -o /dev/null -w "GET /media -> %{http_code} %{content_type} %{size_download}B\n" "$url"

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
# ルームに返事が来るまで、届いた承認依頼すべてに verdict で答える。答えた依頼を表示する
answer_until_reply() {
  local verdict="$1" before id
  before="$(replies)"
  for _ in $(seq 200); do
    for id in $(new_approvals); do
      answered="$answered$id "
      grep -q "always $id" "$LOG" && echo "approval $id: 常に許可あり" || echo "approval $id: 常に許可なし"
      echo "answer $verdict $id"
      wh postback "$A" "perm:$verdict:$id"
    done
    [ "$(replies)" -gt "$before" ] && return 0
    sleep 1
  done
  echo "timeout waiting for a reply"
  return 1
}

echo "== approval (allow)"
wh text "$G1" "$A" "作業ディレクトリに note.txt を作って ok と書いて。終わったら一言で報告して" --mention
answer_until_reply allow

# 拒否のあとに頼むと、拒否を避ける別の手段とみなして実行しないことがある（Haiku で起きた）ので、拒否より先に確かめる
echo "== approval (always)"
wh text "$G1" "$A" "Bash で \`echo always >> always.txt\` を実行して。終わったら一言で報告して" --mention
answer_until_reply always
# 常に許可すると、Claude Code がその範囲を作業ディレクトリの設定（.claude/settings.local.json）に足す。
# 同じコマンドを 2 回頼んで確かめる形にしないのは、エージェントがコマンドを書き足すと範囲から外れ、承認依頼が出るため
echo "-- settings.local.json"; cat "$RELAY_HOME/workspace/.claude/settings.local.json" 2>/dev/null || echo "(なし)"

echo "== approval (deny)"
wh text "$G1" "$A" "作業ディレクトリに denied.txt を作って ng と書いて。拒否されたら、ほかの方法は試さずに一言で報告して" --mention
answer_until_reply deny

sleep 3
echo "== workspace"; ls "$RELAY_HOME/workspace"
for f in note.txt denied.txt always.txt; do echo "-- $f"; cat "$RELAY_HOME/workspace/$f" 2>/dev/null || echo "(なし)"; done
echo "== sent"; cat "$LOG"
echo "== relay log"; grep -E "ツール|実行承認|届いていない|失敗|error" "$RLOG" | cut -c1-260
