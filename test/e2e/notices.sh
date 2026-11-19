#!/usr/bin/env bash
# ターンの知らせの e2e（LINE の API はモック。ADR 0024）。中核の外で、引数はハーネス名（既定は claude）と --full。
# 既定：作業中にハーネスのプロセスを落とすと「失敗」が届き、中継は知らせを待つ。待っている間に Ctrl+C（SIGINT）すると、すぐに止まる。
# 知らせの判定と、待ち方（src/shutdown.ts）は単体テストで守る。ここで確かめるのは、実際の serve でのつながり。
# --full：承認依頼に答えずにいると「承認待ち」と「時間がかかっている」が（時間を 1 分にする）、
# 画面に書いて終えると「返事のない終わり」が届く（後の 2 つはモデルの能力に頼る）。
# 時間のたった知らせは、LINE ではグループに送らないので、1 対 1 のトーク（承認者の DM）で確かめる。
# 実際のハーネスを動かすので、契約の利用枠を少し使う。モデルは Haiku で足りる（ANTHROPIC_MODEL=haiku）。
# 記録と作業ディレクトリは .local/e2e/ に作る。
# 終わったら、ハーネスの会話ログ（Claude Code なら ~/.claude/projects/ の .local-e2e を含むもの）を消す。
set -uo pipefail
. "$(dirname "$0")/lib.sh"

E=.local/e2e
LOG="$E/sent-notices-$H.jsonl"
RLOG="$E/relay-notices-$H"
mkdir -p "$E"
: >"$LOG"
rm -rf "$E/relay-notices-$H" "$RLOG"-*.log
# 作業ディレクトリが <RELAY_HOME>/workspace であることと、既定の設定の読み込みを前提に確かめるので、シェルに残った指定を外す
unset RELAY_WORKSPACE RELAY_HARNESS_SETTINGS RELAY_HARNESS_MEMORY RELAY_APPROVAL_NOTICE_MIN RELAY_SLOW_NOTICE_MIN
export RELAY_ENV_FILE="$E/.env" RELAY_HOME="$PWD/$E/relay-notices-$H" RELAY_LINE_API_BASE=http://127.0.0.1:18099 \
  RELAY_LINE_CHANNEL_SECRET=dummysecret RELAY_LINE_CHANNEL_TOKEN=dummytoken RELAY_PUBLIC_URL=http://127.0.0.1:18080
A=Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

FAILED_NOTICE=今は不調で返事ができません
# 失敗の知らせの送信を詰まらせ、中継が待つ場面を作る
MOCK_LINE_HOLD="$FAILED_NOTICE" MOCK_LINE_HOLD_MS=20000 \
  mise exec -- bun --no-env-file --config=/dev/null test/e2e/mock-line.ts "$LOG" >"$E/mock-notices-$H.log" 2>&1 &
MOCK=$!
RELAY=""
cleanup() { kill "$RELAY" "$MOCK" 2>/dev/null; }
trap cleanup EXIT

# 中継を起動し、新しいセッションができるまで待つ。start <ログ>（環境変数は呼ぶ側で渡す）
start() {
  scripts/relay.sh serve "$H" >"$1" 2>&1 &
  RELAY=$!
  for _ in $(seq 60); do
    grep -q "セッションを開始しました" "$1" && return 0
    kill -0 "$RELAY" 2>/dev/null || break
    sleep 2
  done
  echo "relay did not start"
  tail -20 "$1"
  exit 1
}
# pid の子孫のプロセス
descendants() { local p; for p in $(pgrep -P "$1"); do echo "$p"; descendants "$p"; done; }
# 中継の子孫のうち、コマンドにパターンを含むプロセス
proc() { local p; for p in $(descendants "$RELAY"); do ps -ww -o command= -p "$p" | grep -q -- "$1" && echo "$p"; done | head -1; }
# 中継が止まるまで、最大 t 秒待つ。止まるまでの秒数を ELAPSED に入れる
wait_exit() {
  local t="$1" start
  start=$(date +%s)
  for _ in $(seq $((t * 5))); do
    kill -0 "$RELAY" 2>/dev/null || { ELAPSED=$(($(date +%s) - start)); return 0; }
    sleep 0.2
  done
  ELAPSED=-1
  return 1
}
# 送信の記録の n 行目より後に、パターンを含む送信が出るまで、最大 t 秒待つ（受け取りの合図などの行は数えない）
wait_after() {
  local n="$1" text="$2" t="$3"
  for _ in $(seq "$t"); do
    sent_after "$n" "$text" && return 0
    sleep 1
  done
  return 1
}
# 送信の記録に、パターンを含む送信が出るまで、最大 t 秒待つ。ルームは承認者の DM だけなので、宛先は見ない
# （Reply トークンが使えれば Reply で、使えなければ Push で送る）
dm_notice() { wait_after 0 "$1" "$2"; }
approvals() { grep -c 'yes [a-km-z]\{5\}' "$LOG"; }
approval_id() { grep -o 'yes [a-km-z]\{5\}' "$LOG" | tail -1 | awk '{print $2}'; }
# 承認依頼が新しく届くまで待つ（届いた依頼の数が n を超えるまで）
wait_approval() {
  for _ in $(seq 150); do
    [ "$(approvals)" -gt "$1" ] && return 0
    sleep 1
  done
  return 1
}
wh() { scripts/relay.sh line-webhook "$@" >/dev/null; }
le() { [ "$ELAPSED" -ge 0 ] && [ "$ELAPSED" -le "$1" ]; }

echo "== 1. 作業中にハーネスが落ちる。知らせを待っている間に Ctrl+C"
start "$RLOG-1.log"
check "ペアリング（承認者の DM）" pair_after wh text "$A" "$A" "hi"
n="$(approvals)"
wh text "$A" "$A" "作業ディレクトリに note.txt を作って ok と書いて。終わったら一言で報告して"
# 承認依頼が届いたら、ターンは作業中
check "承認依頼が届く" wait_approval "$n"
harness="$(proc claude-agent-acp)"
echo "harness pid: ${harness:-none}"
check "ハーネスのプロセスが見つかる" test -n "$harness"
[ -n "$harness" ] && kill -9 "$harness"
check "失敗の知らせが届く" dm_notice "$FAILED_NOTICE" 20
check "異常終了をログに書く" grep -q "ハーネスが異常終了したため" "$RLOG-1.log"
# 知らせの送信は詰まっているので、中継は待っている
sleep 2
check "知らせを送り終わるまで待つ" kill -0 "$RELAY"
# scripts/relay.sh と bin/agent-chat-relay は exec するので、RELAY が中継の本体（src/main.ts）
ps -ww -o command= -p "$RELAY" | grep -q "src/main.ts serve" && kill -INT "$RELAY"
check "Ctrl+C で、待つのをやめて止まる" wait_exit 30
echo "stopped after ${ELAPSED}s"
check "すぐに止まる（3 秒以内）" le 3

if [ "$FULL" = 1 ]; then
  echo "== 2. 承認待ち、時間がかかっている、返事のない終わり"
  : >"$LOG"
  export RELAY_APPROVAL_NOTICE_MIN=1 RELAY_SLOW_NOTICE_MIN=1
  start "$RLOG-2.log"
  unset RELAY_APPROVAL_NOTICE_MIN RELAY_SLOW_NOTICE_MIN
  # 承認依頼に答えずにおき、返事もターンの終わりもない時間を作る。
  # Claude Code は長い sleep を裏で動かしてターンを終えるので、時間のかかるコマンドは使わない
  n="$(approvals)"
  wh text "$A" "$A" "作業ディレクトリに slow.txt を作って ok と書いて。作業が終わるまで reply はしないで。終わったら reply で『終わりました』とだけ報告して"
  check "承認依頼が届く（2 回目）" wait_approval "$n"
  check "承認待ちの知らせが届く（1 分）" dm_notice "実行の承認を待っているため" 100
  check_model "時間がかかっていることの知らせが届く（1 分）" dm_notice "時間がかかっています" 30
  wh postback "$A" "perm:allow:$(approval_id)"
  check_model "承認のあと、返事が届く" dm_notice "終わりました" 120
  # 次の発言をこのターンに差し込まないよう、ターンが終わるのを待つ
  sleep 20
  n="$(lines)"
  wh text "$A" "$A" "今回は reply ツールを使わず、画面への出力だけで『了解』と書いて、作業を終えて"
  check_model "返事のない終わりの知らせが届く" wait_after "$n" "返事を送らないまま" 120
fi

echo "== sent"; cat "$LOG"
echo "== relay log"; grep -hE "知らせ|異常終了|停止|失敗|error" "$RLOG"-*.log | cut -c1-260
finish
