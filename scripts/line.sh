#!/usr/bin/env bash
# 段階 2（自作の LINE アダプター + cloud_web）の補助スクリプト。手順は docs/line-adapter-setup.md。
# 秘密情報と許可する userId は、dotenvx で暗号化したリポジトリ直下の .env に置く（段階 1 と共用）。
# 実行時のデータ（セッション、ルームの登録、ルームごとの作業場所）は .local/line/ に置く（.gitignore 対象）。
#
#   scripts/line.sh secrets           # チャネルシークレットとアクセストークンを保存（対話入力）
#   scripts/line.sh allow <userId>[,<userId>...]
#                                     # 依頼を受け付ける LINE userId を保存（上書き）
#   scripts/line.sh room add <groupId> [mention|all] | remove <groupId> | list
#                                     # 動いてよいグループを登録する（再起動は要らない）
#   scripts/line.sh cc                # cc-connect を起動
#   scripts/line.sh adapter           # アダプターを起動
#   scripts/line.sh tunnel            # Cloudflare Quick Tunnel を起動
#   scripts/line.sh webhook <groupId|-> <userId> <text> [--mention] [--redelivery] [--bad-signature] [times]
#                                     # Webhook をローカルへ送る（groupId に - を渡すと 1 対 1 トーク）
#   scripts/line.sh quota             # 今月の Push 等の消費通数と上限を表示
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CCJ_LINE_HOME="${CCJ_LINE_HOME:-$REPO_ROOT/.local/line}"
export CCJ_LINE_PORT="${CCJ_LINE_PORT:-18080}"
export CCJ_CLOUDWEB_PORT="${CCJ_CLOUDWEB_PORT:-18090}"
export CCJ_LOG_LEVEL="${CCJ_LOG_LEVEL:-info}"
ENV_FILE="${CCJ_ENV_FILE:-$REPO_ROOT/.env}"
KEYS_FILE="$(dirname "$ENV_FILE")/.env.keys"
umask 077

# shellcheck source=scripts/lib.sh
source "$REPO_ROOT/scripts/lib.sh"

# アダプターを .local/bin/line にビルドする
build_adapter() {
  (cd "$REPO_ROOT" && mise exec -- go build -o "$REPO_ROOT/.local/bin/line" ./cmd/line) || die "ビルドに失敗しました"
}

# cc-connect とアダプターが共有する token。.env になければ作って暗号化して保存する。
# 有無は復号せずに確かめる（復号に失敗したときに作り直して上書きしないため）
with_env() {
  if [[ -f "$ENV_FILE" ]] && ! grep -q '^CCJ_CLOUDWEB_TOKEN=' "$ENV_FILE"; then
    require_dotenvx
    ensure_ignored
    store_value CCJ_CLOUDWEB_TOKEN "$(openssl rand -hex 32)"
    echo "cc-connect とアダプターの間の token を作り、保存しました"
  fi
  reexec_with_env "$@"
}

cmd_cc_with_env() {
  check_line_env CCJ_CLOUDWEB_TOKEN
  mkdir -p "$CCJ_LINE_HOME/data" "$CCJ_LINE_HOME/workspaces"
  local bin
  bin="$(cc_connect_bin)"
  exec "$bin" -config "$REPO_ROOT/examples/line/config.toml"
}

cmd_adapter_with_env() {
  check_line_env CCJ_CLOUDWEB_TOKEN
  export CCJ_LINE_WEBHOOK_ADDR="127.0.0.1:$CCJ_LINE_PORT"
  export CCJ_CLOUDWEB_ADDR="127.0.0.1:$CCJ_CLOUDWEB_PORT"
  build_adapter
  exec "$REPO_ROOT/.local/bin/line" serve
}

cmd_room() {
  build_adapter
  "$REPO_ROOT/.local/bin/line" room "$@"
}

cmd_webhook() {
  local group_id="${1:-}" user_id="${2:-}" text="${3:-}" times=1 mention=0 redelivery=0 bad=0
  [[ -n "$group_id" && -n "$user_id" && -n "$text" ]] \
    || die "usage: $0 webhook <groupId|-> <userId> <text> [--mention] [--redelivery] [--bad-signature] [times]"
  shift 3
  for arg in "$@"; do
    case "$arg" in
      --mention) mention=1 ;;
      --redelivery) redelivery=1 ;;
      --bad-signature) bad=1 ;;
      *[!0-9]* | "") die "times は正の整数: $arg" ;;
      *) times=$((10#$arg)); ((times > 0)) || die "times は正の整数: $arg" ;;
    esac
  done
  make_tmp
  # 再送を模すため、times 回とも同じ本文（同じ webhookEventId）を送る
  CCJ_G="$group_id" CCJ_U="$user_id" CCJ_T="$text" CCJ_M="$mention" CCJ_R="$redelivery" python3 -I -c '
import json, os, time, uuid
now = int(time.time() * 1000)
g, u, text = os.environ["CCJ_G"], os.environ["CCJ_U"], os.environ["CCJ_T"]
src = {"type": "user", "userId": u} if g == "-" else {"type": "group", "groupId": g, "userId": u}
msg = {"id": str(now), "type": "text", "quoteToken": "local-test", "text": text}
if os.environ["CCJ_M"] == "1":
    msg["text"] = "@Bot " + text
    msg["mention"] = {"mentionees": [{"index": 0, "length": 4, "type": "user", "isSelf": True}]}
print(json.dumps({"destination": "local-test", "events": [{
  "type": "message", "mode": "active", "timestamp": now, "source": src,
  "webhookEventId": "local-" + uuid.uuid4().hex,
  "deliveryContext": {"isRedelivery": os.environ["CCJ_R"] == "1"},
  "replyToken": "local-" + uuid.uuid4().hex, "message": msg}]}))
' >"$CCJ_TMP_FILE"
  post_signed_webhook "$CCJ_TMP_FILE" "$times" "$bad"
}

case "${1:-}" in
  secrets) cmd_secrets ;;
  allow) shift; cmd_allow "$@" ;;
  room) shift; cmd_room "$@" ;;
  cc) with_env __cc ;;
  __cc) cmd_cc_with_env ;;
  adapter) with_env __adapter ;;
  __adapter) cmd_adapter_with_env ;;
  tunnel) cmd_tunnel ;;
  webhook) shift; cmd_webhook "$@" ;;
  quota) cmd_quota ;;
  *) sed -n '2,16p' "$0"; exit 1 ;;
esac
