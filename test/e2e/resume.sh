#!/usr/bin/env bash
# 再開の e2e（LINE の API はモック）。引数：ハーネス名（既定は claude）。
# 新しいセッションで合言葉を覚えさせ、中継を止めてから --session-id で再開し、
# 合言葉を覚えているか、返事と実行承認が働くかを確認する。e2e の中核の 1 つ（ADR 0023）。
# 各手順を判定し、1 つでも失敗すれば 0 以外で終わる。
# 実際のハーネスを動かすので、契約の利用枠を少し使う。記録と作業ディレクトリは .local/e2e/ に作る。
# 終わったら、ハーネスの会話ログ（Claude Code なら ~/.claude/projects/ の .local-e2e を含むもの）を消す。
set -uo pipefail
. "$(dirname "$0")/lib.sh"

E=.local/e2e
LOG="$E/sent-resume-$H.jsonl"
RLOG="$E/relay-resume-$H"
mkdir -p "$E"
: >"$LOG"
rm -rf "$E/relay-resume-$H"
# 作業ディレクトリが <RELAY_HOME>/workspace であることと、既定の設定の読み込みを前提に確かめるので、シェルに残った指定を外す
unset RELAY_WORKSPACE RELAY_HARNESS_SETTINGS RELAY_HARNESS_MEMORY
export RELAY_ENV_FILE="$E/.env" RELAY_HOME="$PWD/$E/relay-resume-$H" RELAY_LINE_API_BASE=http://127.0.0.1:18099 \
  RELAY_LINE_CHANNEL_SECRET=dummysecret RELAY_LINE_CHANNEL_TOKEN=dummytoken RELAY_PUBLIC_URL=http://127.0.0.1:18080
G1=C111aaaaaaaaaaaaaaaaaaaaaaaaaaaaa
A=Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

mise exec -- bun --no-env-file --config=/dev/null test/e2e/mock-line.ts "$LOG" >"$E/mock-resume-$H.log" 2>&1 &
MOCK=$!
RELAY=""
cleanup() { kill "$RELAY" "$MOCK" 2>/dev/null; }
trap cleanup EXIT

# 中継を起動し、ログに $2 が出るまで待つ
start() {
  local log="$1" ready="$2"
  shift 2
  scripts/relay.sh serve "$H" "$@" >"$log" 2>&1 &
  RELAY=$!
  for _ in $(seq 60); do
    grep -q "$ready" "$log" && return 0
    kill -0 "$RELAY" 2>/dev/null || break
    sleep 2
  done
  echo "relay did not start"
  tail -20 "$log"
  exit 1
}
stop() {
  kill "$RELAY" 2>/dev/null
  wait "$RELAY" 2>/dev/null
}

wh() { scripts/relay.sh line-webhook "$@" >/dev/null; }
pair_after() { local n; n="$(lines)"; wh "$@"; waitfor "$n" 10 && scripts/relay.sh pair "$(code)"; }

echo "== 1st run (new session)"
start "$RLOG-1.log" "セッションを開始しました"
check "ペアリング（開発チーム）" pair_after join "$G1"
check "ペアリング（承認者の DM）" pair_after text "$A" "$A" "hi"
n="$(lines)"; wh text "$G1" "$A" "合言葉は『あおいろ』です。覚えたら『覚えました』とだけ返して。あとで聞いたら、合言葉を答えて" --mention
check "新しいセッションでの返信" waitfor "$n"
sid="$(grep -o '"sessionId":"[^"]*"' "$RLOG-1.log" | head -1 | cut -d'"' -f4)"
echo "session id: ${sid:-none}"
stop
# ID がなければ、再開を確かめられない
check "セッションの ID が分かる" test -n "$sid"
[ -n "$sid" ] || finish

echo "== 2nd run (resume)"
start "$RLOG-2.log" "セッションを再開しました" --session-id "$sid"
grep -E "セッションを再開しました|モードを" "$RLOG-2.log" | cut -c1-300
n="$(lines)"; wh text "$G1" "$A" "さっきの合言葉を一言で" --mention
waitfor "$n"
check "再開したセッションが、前の会話を覚えている" sent_after "$n" 'あおいろ'

echo "== approval after resume"
wh text "$G1" "$A" "作業ディレクトリに note.txt を作って ok と書いて。終わったら一言で報告して" --mention
id=""
for _ in $(seq 150); do
  id="$(grep -o 'yes [a-km-z]\{5\}' "$LOG" | tail -1 | awk '{print $2}')"
  [ -n "$id" ] && break
  sleep 1
done
echo "approval id: ${id:-none}"
check "再開後に承認依頼が届く" test -n "$id"
n="$(lines)"; [ -n "$id" ] && wh postback "$A" "perm:allow:$id"
check "再開後の承認のあと、返事が届く" waitfor "$((n + 1))"
sleep 3
stop
check "再開後に許可した操作が行われる" grep -q ok "$RELAY_HOME/workspace/note.txt"

echo "== 3rd run (unknown id must fail without creating a new session)"
scripts/relay.sh serve "$H" --session-id 00000000-0000-4000-8000-000000000000 >"$RLOG-3.log" 2>&1 &
RELAY=$!
wait "$RELAY"
rc=$?
echo "exit: $rc"
grep -E "relay: |セッションを開始しました" "$RLOG-3.log" | cut -c1-300
check "存在しない ID では、0 以外で終わる" test "$rc" -ne 0
check "存在しない ID では、新しいセッションを作らない" bash -c '! grep -q "セッションを開始しました" "$1"' _ "$RLOG-3.log"

echo "== workspace"; cat "$RELAY_HOME/workspace/note.txt" 2>/dev/null
echo "== sent"; cat "$LOG"
finish
