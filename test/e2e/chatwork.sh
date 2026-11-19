#!/usr/bin/env bash
# 中継の e2e（Chatwork の API はモック）。引数：ハーネス名（既定は claude）と --full。
# e2e の中核の外（ADR 0023）。--full を付けると、モデルの能力に頼る手順（画像の説明、停止中に届いた依頼を調べる）も走らせる。
# 各手順を判定し、1 つでも失敗すれば 0 以外で終わる。
# 実際のハーネスを動かすので、契約の利用枠を少し使う。記録と作業ディレクトリは .local/e2e/ に作る。
# 終わったら、ハーネスの会話ログ（Claude Code なら ~/.claude/projects/ の .local-e2e を含むもの）を消す。
set -uo pipefail
. "$(dirname "$0")/lib.sh"

E=.local/e2e
LOG="$E/sent-chatwork-$H.jsonl"
RLOG="$E/relay-chatwork-$H.log"
MOCK_URL=http://127.0.0.1:18098
mkdir -p "$E"
: >"$LOG"
rm -rf "$E/relay-chatwork-$H"
rm -f "$E/answered-chatwork-$H"
unset RELAY_LINE_CHANNEL_SECRET RELAY_LINE_CHANNEL_TOKEN
# 作業ディレクトリが <RELAY_HOME>/workspace であることと、既定の設定の読み込みを前提に確かめるので、シェルに残った指定を外す
unset RELAY_WORKSPACE RELAY_HARNESS_SETTINGS RELAY_HARNESS_MEMORY
export RELAY_ENV_FILE="$E/.env" RELAY_HOME="$PWD/$E/relay-chatwork-$H" RELAY_CHATWORK_API_BASE=$MOCK_URL \
  RELAY_CHATWORK_API_TOKEN=dummytoken RELAY_CHATWORK_POLL_SEC=2
GROUP=7000 DM=7001 SALES=7003 ALICE=1 BOB=2
# 開発チームは登録済みで始める。起動前に届いていた依頼（モックが用意する）は、記録だけされるはず
mkdir -p "$RELAY_HOME"
echo '{"allowFrom":[],"rooms":{"chatwork:r7000":{"requireMention":true,"allowFrom":[]}},"pending":{}}' >"$RELAY_HOME/access.json"

mise exec -- bun --no-env-file --config=/dev/null test/e2e/mock-chatwork.ts "$LOG" >"$E/mock-chatwork-$H.log" 2>&1 &
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
mention() { printf '[To:100]AI係さん\n%s' "$1"; }
pair_after() { local n; n="$(lines)"; say "$@"; waitfor "$n" 15 && scripts/relay.sh pair "$(code)"; }

echo "== pairing (DM, group)"
check "ペアリング（承認者の DM）" pair_after $DM $ALICE "hi"
check "ペアリング（営業チーム）" pair_after $SALES $ALICE "$(mention "はじめまして")"
echo "codes so far: $(grep -c 'relay pair' "$LOG")"
# 開発チームは登録済みなので、起動前の依頼が渡っていれば、そこへ返事が届く
not_delivered() { [ "$(grep -c 'relay pair' "$LOG")" -eq 2 ] && ! grep -q '"room":7000' "$LOG"; }
check "起動前に届いていた依頼は、渡さない（コードは DM と営業チームの 2 つだけ）" not_delivered

echo "== reply in group"
n="$(lines)"; say $GROUP $ALICE "$(mention "自己紹介を一言で")"
check "ルームでの返信" waitfor "$n"

if [ "$FULL" = 1 ]; then
  echo "== image from someone else, then ask"
  say $GROUP $BOB "[info][title][dtext:file_uploaded][/title][preview id=55 ht=100][download:55]photo.png (1 KB)[/download][/info]"
  sleep 3
  n="$(lines)"; say $GROUP $ALICE "$(mention "さっきボブが送った画像の色を一語で教えて")"
  waitfor "$n" 120
  check_model "画像の説明（赤）" sent_after "$n" '赤'

  echo "== stale request is readable but was not delivered"
  n="$(lines)"; say $GROUP $ALICE "$(mention "このルームで、停止中に送られていた依頼の合言葉を fetch_messages で調べて、一語で答えて")"
  waitfor "$n" 120
  check_model "停止中に届いた依頼を、記録から読める" sent_after "$n" 'すずらん'
fi

echo "== file return with approval (DM text)"
say $GROUP $ALICE "$(mention "作業ディレクトリに report.csv を作って a,b と 1 行だけ書き、それをこのルームにファイルで送って")"
for _ in $(seq 200); do
  grep -q '"kind":"file"' "$LOG" && break
  id="$(grep -o 'yes [a-km-z]\{5\}' "$LOG" | tail -1 | awk '{print $2}')"
  if [ -n "$id" ] && ! grep -q "answered $id" "$E/answered-chatwork-$H" 2>/dev/null; then
    echo "approve $id"; say $DM $ALICE "yes $id"; echo "answered $id" >>"$E/answered-chatwork-$H"
  fi
  sleep 1
done
check "承認依頼が届く" test -s "$E/answered-chatwork-$H"
check "許可のあと、ファイルが届く" grep -q '"kind":"file"' "$LOG"
rm -f "$E/answered-chatwork-$H"

echo "== bot added to a new room"
n="$(lines)"; curl -s -o /dev/null "$MOCK_URL/_join" --data-urlencode "room=7004" --data-urlencode "name=新しいルーム"
check "ルームに加えられたら、登録のコードを送る" waitfor "$n" 15

sleep 3
echo "== sent"; cat "$LOG"
echo "== relay log"; grep -E "ツール|実行承認|失敗|error|できません" "$RLOG" | cut -c1-260
finish
