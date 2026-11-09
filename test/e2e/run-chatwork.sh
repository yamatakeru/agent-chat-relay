#!/usr/bin/env bash
# 中継の e2e（Chatwork の API はモック）。引数：ハーネス名（既定は claude）。
# 実際のハーネスを動かすので、契約の利用枠を少し使う。記録と作業場所は .local/e2e/ に作る。
# 終わったら、ハーネスの会話ログ（Claude Code なら ~/.claude/projects/ の .local-e2e を含むもの）を消す。
set -uo pipefail

H="${1:-claude}"
E=.local/e2e
LOG="$E/sent-chatwork-$H.jsonl"
RLOG="$E/relay-chatwork-$H.log"
MOCK_URL=http://127.0.0.1:18098
mkdir -p "$E"
: >"$LOG"
rm -rf "$E/relay-chatwork-$H"
unset RELAY_LINE_CHANNEL_SECRET RELAY_LINE_CHANNEL_TOKEN
export RELAY_ENV_FILE="$E/.env" RELAY_HOME="$PWD/$E/relay-chatwork-$H" RELAY_CHATWORK_API_BASE=$MOCK_URL \
  RELAY_CHATWORK_API_TOKEN=dummytoken RELAY_CHATWORK_POLL_SEC=2
GROUP=7000 DM=7001 SALES=7003 ALICE=1 BOB=2
# 開発チームは登録済みで始める。起動前に届いていた依頼（モックが用意する）は、記録だけされるはず
mkdir -p "$RELAY_HOME"
echo '{"allowFrom":[],"rooms":{"chatwork:r7000":{"requireMention":true,"allowFrom":[]}},"pending":{}}' >"$RELAY_HOME/access.json"

mise exec -- bun test/e2e/mock-chatwork.ts "$LOG" >"$E/mock-chatwork-$H.log" 2>&1 &
MOCK=$!
sleep 1
scripts/relay.sh serve "$H" >"$RLOG" 2>&1 &
RELAY=$!
cleanup() { kill "$RELAY" "$MOCK" 2>/dev/null; }
trap cleanup EXIT
for _ in $(seq 60); do
  grep -q "セッションを開始しました" "$RLOG" && break
  sleep 2
done
grep -q "セッションを開始しました" "$RLOG" || { echo "relay did not start"; tail -20 "$RLOG"; exit 1; }

say() { curl -s -o /dev/null "$MOCK_URL/_say" --data-urlencode "room=$1" --data-urlencode "account=$2" --data-urlencode "body=$3"; }
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
mention() { printf '[To:100]AI係さん\n%s' "$1"; }

echo "== pairing (DM, group)"
n="$(lines)"; say $DM $ALICE "hi"; waitfor "$n" 15; scripts/relay.sh pair "$(code)"
n="$(lines)"; say $SALES $ALICE "$(mention "はじめまして")"; waitfor "$n" 15; scripts/relay.sh pair "$(code)"
echo "codes so far: $(grep -c 'relay pair' "$LOG")（DM と営業チームの 2 つ。起動前の依頼は記録だけで、何も返さない）"

echo "== reply in group"
n="$(lines)"; say $GROUP $ALICE "$(mention "自己紹介を一言で")"; waitfor "$n"

echo "== image from someone else, then ask"
say $GROUP $BOB "[info][title][dtext:file_uploaded][/title][preview id=55 ht=100][download:55]photo.png (1 KB)[/download][/info]"
sleep 3
n="$(lines)"; say $GROUP $ALICE "$(mention "さっきボブが送った画像の色を一語で教えて")"; waitfor "$n" 200

echo "== stale request is readable but was not delivered"
n="$(lines)"; say $GROUP $ALICE "$(mention "このルームで、停止中に送られていた依頼の合言葉を fetch_messages で調べて、一語で答えて")"; waitfor "$n" 200

echo "== file return with approval (DM text)"
say $GROUP $ALICE "$(mention "作業場所に report.csv を作って a,b と 1 行だけ書き、それをこのルームにファイルで送って")"
for _ in $(seq 200); do
  grep -q '"kind":"file"' "$LOG" && break
  id="$(grep -o 'yes [a-km-z]\{5\}' "$LOG" | tail -1 | awk '{print $2}')"
  if [ -n "$id" ] && ! grep -q "answered $id" "$E/answered-$H" 2>/dev/null; then
    echo "approve $id"; say $DM $ALICE "yes $id"; echo "answered $id" >>"$E/answered-$H"
  fi
  sleep 1
done
rm -f "$E/answered-$H"

echo "== bot added to a new room"
n="$(lines)"; curl -s -o /dev/null "$MOCK_URL/_join" --data-urlencode "room=7004" --data-urlencode "name=新しいルーム"; waitfor "$n" 15

sleep 3
echo "== sent"; cat "$LOG"
echo "== relay log"; grep -E "ツール|実行承認|失敗|error|できません" "$RLOG" | cut -c1-260
