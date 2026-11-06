#!/usr/bin/env bash
# 段階 1（cc-connect 標準の LINE platform で実測）の補助スクリプト。
# 秘密情報と許可する userId は、dotenvx で暗号化した ~/.cc-connect-jtc/line-native/.env に置く
# （復号鍵は同じ場所の .env.keys）。平文の秘密をコマンド引数や履歴に残さない。
#
#   scripts/line-native.sh secrets    # チャネルシークレットとアクセストークンを保存（対話入力）
#   scripts/line-native.sh allow <userId>[,<userId>...]
#                                     # 依頼を受け付ける LINE userId を保存（上書き）
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
ENV_FILE="$CCJ_LINE_NATIVE_HOME/.env"
umask 077

die() { echo "error: $*" >&2; exit 1; }

require_dotenvx() {
  command -v dotenvx >/dev/null || die "dotenvx が見つかりません"
}

# 環境変数が設定済みならそれを使う（ダミー値でのローカル検証用）。未設定なら .env から復号して読む
secret_value() {
  local var="$1"
  if [[ -n "${!var:-}" ]]; then printf '%s' "${!var}"; return; fi
  require_dotenvx
  dotenvx get "$var" -f "$ENV_FILE" --strict 2>/dev/null \
    || die "$ENV_FILE に $var がありません。先に '$0 secrets' を実行してください"
}

# npm 版の bin/cc-connect は Node のランチャーで、SIGTERM を Go の本体に転送しない。
# ランチャーを止めても本体が残るので、本体を直接起動する
cc_connect_bin() {
  local bin
  bin="$(cd "$REPO_ROOT" && mise where npm:cc-connect)/lib/node_modules/cc-connect/bin/cc-connect"
  [[ -x "$bin" ]] || die "cc-connect の本体が見つかりません: ${bin}（mise install を実行してください）"
  printf '%s' "$bin"
}

ensure_home() {
  mkdir -p "$CCJ_LINE_NATIVE_HOME/data" "$CCJ_LINE_NATIVE_HOME/workspace"
  chmod 700 "$CCJ_LINE_NATIVE_HOME"
  if [[ ! -d "$CCJ_LINE_NATIVE_HOME/workspace/.git" ]]; then
    git -C "$CCJ_LINE_NATIVE_HOME/workspace" init -q
  fi
}

# 入力した値を .env に書き、そのキーだけをすぐ暗号化する。
# dotenvx set は値をコマンド引数で受け取るため、秘密には使わない
store_secret() {
  local key="$1" label="$2" value
  read -rsp "$label: " value
  echo
  [[ -n "$value" ]] || die "入力が空です"
  [[ "$value" =~ ^[A-Za-z0-9+/=._-]+$ ]] || die "想定外の文字が含まれています（前後の空白など）"
  touch "$ENV_FILE"
  sed -i '' "/^$key=/d" "$ENV_FILE"
  printf "%s='%s'\n" "$key" "$value" >>"$ENV_FILE"
  # 初回は復号鍵を画面に表示するので、出力は捨てる
  if ! dotenvx encrypt -f "$ENV_FILE" -k "$key" >/dev/null 2>&1 \
    || ! grep -q "^$key='encrypted:" "$ENV_FILE"; then
    sed -i '' "/^$key=/d" "$ENV_FILE"
    die "$key の暗号化に失敗したため、保存しませんでした"
  fi
}

cmd_secrets() {
  require_dotenvx
  ensure_home
  echo "LINE Developers コンソールの値を入力します。入力内容は画面に表示されません。"
  store_secret CCJ_LINE_CHANNEL_SECRET "[1/2] チャネルシークレット"
  store_secret CCJ_LINE_CHANNEL_TOKEN "[2/2] チャネルアクセストークン（長期）"
  echo "保存しました: ${ENV_FILE}（復号鍵: $CCJ_LINE_NATIVE_HOME/.env.keys）"
}

cmd_allow() {
  local ids="${1:-}" id
  [[ -n "$ids" ]] || die "usage: $0 allow <userId>[,<userId>...]"
  # "*" や空は全員許可になるため、LINE の userId の形式（U + 16 進 32 桁）だけを受け付ける
  IFS=, read -ra list <<<"$ids"
  for id in "${list[@]}"; do
    [[ "$id" =~ ^U[0-9a-f]{32}$ ]] || die "LINE の userId ではありません: '$id'"
  done
  require_dotenvx
  ensure_home
  dotenvx set CCJ_LINE_ALLOW_FROM "$ids" -f "$ENV_FILE" >/dev/null 2>&1 || die "保存に失敗しました"
  echo "許可する userId を ${#list[@]} 件保存しました。cc-connect を再起動すると反映されます。"
}

cmd_run() {
  ensure_home
  if [[ -f "$ENV_FILE" ]]; then
    require_dotenvx
    # .env を復号して環境変数に入れてから、自分自身を呼び直す。既存の環境変数が優先される
    exec dotenvx run --quiet --strict -f "$ENV_FILE" -- "$0" __run-with-env
  fi
  cmd_run_with_env
}

cmd_run_with_env() {
  [[ -n "${CCJ_LINE_CHANNEL_SECRET:-}" && -n "${CCJ_LINE_CHANNEL_TOKEN:-}" ]] \
    || die "チャネルシークレットまたはアクセストークンがありません。先に '$0 secrets' を実行してください"
  if [[ -z "${CCJ_LINE_ALLOW_FROM+x}" ]]; then
    # 未登録のうちは誰にも一致しない値にする。debug ログで userId を確認してから allow で登録する
    export CCJ_LINE_ALLOW_FROM=none-yet
    echo "note: 許可する userId が未登録のため、誰の依頼にも応答しません" >&2
  fi
  case "$CCJ_LINE_ALLOW_FROM" in
    "" | *"*"*) die "CCJ_LINE_ALLOW_FROM が空または '*' を含みます（全員許可になるため禁止）" ;;
  esac
  local bin
  bin="$(cc_connect_bin)"
  # cc-connect は設定ファイルを書き換えることがあるため、毎回リポジトリの例から複製して使う
  install -m 600 "$REPO_ROOT/examples/line-native/config.toml" "$CCJ_LINE_NATIVE_HOME/config.toml"
  exec "$bin" -config "$CCJ_LINE_NATIVE_HOME/config.toml"
}

cmd_tunnel() {
  # リポジトリの mise.toml で固定した版を使うため、リポジトリで実行する
  cd "$REPO_ROOT"
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
    secret="$(secret_value CCJ_LINE_CHANNEL_SECRET)"
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
  token="$(secret_value CCJ_LINE_CHANNEL_TOKEN)"
  # トークンをコマンド引数に載せないよう、ヘッダーはプロセス置換で渡す
  for path in quota quota/consumption; do
    printf '%s: ' "$path"
    curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$token") "https://api.line.me/v2/bot/message/$path"
    echo
  done
}

case "${1:-}" in
  secrets) cmd_secrets ;;
  allow) shift; cmd_allow "$@" ;;
  run) cmd_run ;;
  __run-with-env) cmd_run_with_env ;;
  tunnel) cmd_tunnel ;;
  webhook) shift; cmd_webhook "$@" ;;
  quota) cmd_quota ;;
  *) sed -n '2,14p' "$0"; exit 1 ;;
esac
