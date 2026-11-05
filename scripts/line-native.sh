#!/usr/bin/env bash
# 段階 1（cc-connect 標準の LINE platform で実測）の補助スクリプト。
# 秘密情報は macOS キーチェーンから読み出し、ファイルやコマンド履歴には残さない。
#
#   scripts/line-native.sh secrets    # チャネルシークレットとアクセストークンをキーチェーンへ保存（対話入力）
#   scripts/line-native.sh run        # cc-connect を起動
#   scripts/line-native.sh tunnel     # Cloudflare Quick Tunnel を起動
#   scripts/line-native.sh webhook <groupId> <userId> <text> [times] [--bad-signature]
#                                     # 同一イベントの Webhook を times 回（既定 1）ローカルへ送る（検証項目 4・5 用）
#   scripts/line-native.sh quota      # 今月の Push 等の消費通数と上限を表示
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CCJ_LINE_NATIVE_HOME="${CCJ_LINE_NATIVE_HOME:-$HOME/.cc-connect-jtc/line-native}"
export CCJ_LINE_PORT="${CCJ_LINE_PORT:-18080}"
export CCJ_LOG_LEVEL="${CCJ_LOG_LEVEL:-info}"
ENV_FILE="$CCJ_LINE_NATIVE_HOME/env"
KC_SECRET="cc-connect-jtc.line.channel-secret"
KC_TOKEN="cc-connect-jtc.line.channel-token"

die() { echo "error: $*" >&2; exit 1; }

# 環境変数が設定済みならそれを使う（ダミー値でのローカル検証用）。未設定ならキーチェーンから読む
secret_value() {
  local var="$1" service="$2"
  if [[ -n "${!var:-}" ]]; then printf '%s' "${!var}"; else kc_read "$service"; fi
}

# npm 版の bin/cc-connect は Node のランチャーで、SIGTERM を Go の本体に転送しない。
# ランチャーを止めても本体が残るので、本体を直接起動する
cc_connect_bin() {
  local bin
  bin="$(cd "$REPO_ROOT" && mise where npm:cc-connect)/lib/node_modules/cc-connect/bin/cc-connect"
  [[ -x "$bin" ]] || die "cc-connect の本体が見つかりません: $bin（mise install を実行してください）"
  printf '%s' "$bin"
}

kc_read() {
  security find-generic-password -a "$USER" -s "$1" -w 2>/dev/null \
    || die "キーチェーンに $1 がありません。先に '$0 secrets' を実行してください"
}

ensure_home() {
  mkdir -p "$CCJ_LINE_NATIVE_HOME/data" "$CCJ_LINE_NATIVE_HOME/workspace"
  chmod 700 "$CCJ_LINE_NATIVE_HOME"
  if [[ ! -d "$CCJ_LINE_NATIVE_HOME/workspace/.git" ]]; then
    git -C "$CCJ_LINE_NATIVE_HOME/workspace" init -q
  fi
  if [[ ! -f "$ENV_FILE" ]]; then
    # 許可する LINE userId（カンマ区切り）。最初は誰にも一致しない値にしておき、
    # debug ログで userId を確認してから書き換える。
    printf 'CCJ_LINE_ALLOW_FROM=none-yet\n' >"$ENV_FILE"
    chmod 600 "$ENV_FILE"
  fi
}

cmd_secrets() {
  echo "LINE Developers コンソールの値を入力します。入力内容は画面に表示されません。"
  echo "[1/2] チャネルシークレット"
  security add-generic-password -U -a "$USER" -s "$KC_SECRET" -w
  echo "[2/2] チャネルアクセストークン（長期）"
  security add-generic-password -U -a "$USER" -s "$KC_TOKEN" -w
  echo "保存しました。"
}

cmd_run() {
  ensure_home
  # env ファイルは source せず、必要な値だけを読む
  CCJ_LINE_ALLOW_FROM="$(sed -n 's/^CCJ_LINE_ALLOW_FROM=//p' "$ENV_FILE" | tail -n 1)"
  export CCJ_LINE_ALLOW_FROM
  case "${CCJ_LINE_ALLOW_FROM:-}" in
    "" | "*") die "$ENV_FILE の CCJ_LINE_ALLOW_FROM が空または '*' です（全員許可になるため禁止）" ;;
  esac
  CCJ_LINE_CHANNEL_SECRET="$(secret_value CCJ_LINE_CHANNEL_SECRET "$KC_SECRET")"
  CCJ_LINE_CHANNEL_TOKEN="$(secret_value CCJ_LINE_CHANNEL_TOKEN "$KC_TOKEN")"
  export CCJ_LINE_CHANNEL_SECRET CCJ_LINE_CHANNEL_TOKEN
  local bin
  bin="$(cc_connect_bin)"
  # cc-connect は設定ファイルを書き換えることがあるため、毎回リポジトリの例から複製して使う
  install -m 600 "$REPO_ROOT/examples/line-native/config.toml" "$CCJ_LINE_NATIVE_HOME/config.toml"
  exec "$bin" -config "$CCJ_LINE_NATIVE_HOME/config.toml"
}

cmd_tunnel() {
  exec mise exec -- cloudflared tunnel --no-autoupdate --url "http://localhost:$CCJ_LINE_PORT"
}

cmd_webhook() {
  local group_id="${1:-}" user_id="${2:-}" text="${3:-}" times=1 mode=""
  [[ -n "$group_id" && -n "$user_id" && -n "$text" ]] \
    || die "usage: $0 webhook <groupId> <userId> <text> [times] [--bad-signature]"
  shift 3
  for arg in "$@"; do
    case "$arg" in
      --bad-signature) mode="$arg" ;;
      *[!0-9]* | "") die "times は正の整数: $arg" ;;
      *) times=$((10#$arg)); ((times > 0)) || die "times は正の整数: $arg" ;;
    esac
  done
  local body
  body="$(mktemp)"
  trap 'rm -f "$body"' RETURN
  # 再送を模すため、webhookEventId と message.id は毎回同じ値にする
  CCJ_G="$group_id" CCJ_U="$user_id" CCJ_T="$text" python3 -I -c '
import json, os, time, uuid
now = int(time.time() * 1000)
print(json.dumps({"destination": "local-test", "events": [{
  "type": "message", "mode": "active", "timestamp": now,
  "source": {"type": "group", "groupId": os.environ["CCJ_G"], "userId": os.environ["CCJ_U"]},
  "webhookEventId": "local-" + uuid.uuid4().hex, "deliveryContext": {"isRedelivery": False},
  "replyToken": "local-test",
  "message": {"id": str(now), "type": "text", "quoteToken": "local-test", "text": os.environ["CCJ_T"]}}]}))
' >"$body"
  local secret sig i
  if [[ "$mode" == "--bad-signature" ]]; then
    secret="definitely-not-the-channel-secret"
  else
    secret="$(secret_value CCJ_LINE_CHANNEL_SECRET "$KC_SECRET")"
  fi
  # 秘密をコマンド引数に載せないよう、環境変数経由で HMAC-SHA256 を計算する
  sig="$(CCJ_HMAC_KEY="$secret" python3 -I -c 'import base64,hashlib,hmac,os,sys; print(base64.b64encode(hmac.new(os.environ["CCJ_HMAC_KEY"].encode(), sys.stdin.buffer.read(), hashlib.sha256).digest()).decode())' <"$body")"
  for ((i = 1; i <= times; i++)); do
    printf 'send %d/%d: HTTP ' "$i" "$times"
    curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
      -H 'Content-Type: application/json' \
      -H "X-Line-Signature: $sig" \
      --data-binary "@$body" \
      "http://localhost:$CCJ_LINE_PORT/callback"
  done
}

cmd_quota() {
  local token path
  token="$(secret_value CCJ_LINE_CHANNEL_TOKEN "$KC_TOKEN")"
  # トークンをコマンド引数に載せないよう、ヘッダーはプロセス置換で渡す
  for path in quota quota/consumption; do
    printf '%s: ' "$path"
    curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$token") "https://api.line.me/v2/bot/message/$path"
    echo
  done
}

case "${1:-}" in
  secrets) cmd_secrets ;;
  run) cmd_run ;;
  tunnel) cmd_tunnel ;;
  webhook) shift; cmd_webhook "$@" ;;
  quota) cmd_quota ;;
  *) sed -n '2,11p' "$0"; exit 1 ;;
esac
