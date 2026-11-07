#!/usr/bin/env bash
# 段階 1（cc-connect 標準の LINE platform で実測）の補助スクリプト。
# 秘密情報と許可する userId は、dotenvx で暗号化したリポジトリ直下の .env に置く
# （復号鍵は同じ場所の .env.keys。どちらも .gitignore 対象）。平文の秘密をコマンド引数や履歴に残さない。
# 実行時のデータ（セッション、Claude の作業場所）はリポジトリ内の .local/line-native/ に置く（.gitignore 対象）。
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
export CCJ_LINE_NATIVE_HOME="${CCJ_LINE_NATIVE_HOME:-$REPO_ROOT/.local/line-native}"
export CCJ_LINE_PORT="${CCJ_LINE_PORT:-18080}"
export CCJ_LOG_LEVEL="${CCJ_LOG_LEVEL:-info}"
ENV_FILE="${CCJ_ENV_FILE:-$REPO_ROOT/.env}"
KEYS_FILE="$(dirname "$ENV_FILE")/.env.keys"
umask 077

# shellcheck source=scripts/lib.sh
source "$REPO_ROOT/scripts/lib.sh"

ensure_home() {
  mkdir -p "$CCJ_LINE_NATIVE_HOME/data" "$CCJ_LINE_NATIVE_HOME/workspace"
  chmod 700 "$CCJ_LINE_NATIVE_HOME"
  if [[ ! -d "$CCJ_LINE_NATIVE_HOME/workspace/.git" ]]; then
    git -C "$CCJ_LINE_NATIVE_HOME/workspace" init -q
  fi
}

cmd_run() {
  ensure_home
  reexec_with_env __run-with-env
}

cmd_run_with_env() {
  check_line_env  # 追加で必須の変数はない
  local bin
  bin="$(cc_connect_bin)"
  exec "$bin" -config "$REPO_ROOT/examples/line-native/config.toml"
}

cmd_webhook() {
  local group_id="${1:-}" user_id="${2:-}" text="${3:-}" times=1 bad=0
  [[ -n "$group_id" && -n "$user_id" && -n "$text" ]] \
    || die "usage: $0 webhook <groupId> <userId> <text> [times] [--bad-signature]"
  shift 3
  for arg in "$@"; do
    case "$arg" in
      --bad-signature) bad=1 ;;
      *[!0-9]* | "") die "times は正の整数: $arg" ;;
      *) times=$((10#$arg)); ((times > 0)) || die "times は正の整数: $arg" ;;
    esac
  done
  make_tmp
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
' >"$CCJ_TMP_FILE"
  post_signed_webhook "$CCJ_TMP_FILE" "$times" "$bad"
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
