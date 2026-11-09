#!/usr/bin/env bash
# 中継の e2e（LINE の API はモック）。引数：ハーネス名（claude か opencode）。
# 実際のハーネスを動かすので、契約の利用枠を少し使う。記録と作業場所は .local/e2e/ に作る。
# 終わったら、ハーネスの会話ログ（Claude Code なら ~/.claude/projects/ の .local-e2e を含むもの）を消す。
set -uo pipefail

H="$1"
E=.local/e2e
LOG="$E/sent-$H.jsonl"
RLOG="$E/relay-$H.log"
mkdir -p "$E"
: >"$LOG"
export RELAY_ENV_FILE="$E/.env" RELAY_HOME="$PWD/$E/relay-$H" RELAY_LINE_API_BASE=http://127.0.0.1:18099 \
  RELAY_LINE_CHANNEL_SECRET=dummysecret RELAY_LINE_CHANNEL_TOKEN=dummytoken
G1=C111aaaaaaaaaaaaaaaaaaaaaaaaaaaaa
G2=C222bbbbbbbbbbbbbbbbbbbbbbbbbbbbb
A=Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
B=Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

mise exec -- bun test/e2e/mock-line.ts "$LOG" >"$E/mock-$H.log" 2>&1 &
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

wh() { scripts/relay.sh webhook "$@" >/dev/null; }
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

echo "== approval"
wh text "$G1" "$A" "作業場所に note.txt を作って ok と書いて。終わったら一言で報告して" --mention
id=""
for _ in $(seq 150); do
  id="$(grep -o 'yes [a-km-z]\{5\}' "$LOG" | tail -1 | awk '{print $2}')"
  [ -n "$id" ] && break
  sleep 1
done
echo "approval id: ${id:-none}"
n="$(lines)"; [ -n "$id" ] && wh postback "$A" "perm:allow:$id"; waitfor "$((n + 1))"

sleep 3
echo "== workspace"; ls "$RELAY_HOME/workspace"; cat "$RELAY_HOME/workspace/note.txt" 2>/dev/null
echo "== sent"; cat "$LOG"
echo "== relay log"; grep -E "ツール|実行承認|届いていない|失敗|error" "$RLOG" | cut -c1-260
