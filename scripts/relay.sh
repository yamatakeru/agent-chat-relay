#!/usr/bin/env bash
# agent-chat-relay の操作。秘密情報は dotenvx で暗号化したリポジトリ直下の .env に置き、
# 平文の秘密をコマンド引数や履歴に残さない（AGENTS.md）。
#
#   scripts/relay.sh secrets            LINE のチャネルシークレットとアクセストークンを保存する
#   scripts/relay.sh serve [harness]    中継を起動する（harness：claude（既定）か opencode）
#   scripts/relay.sh pair <code>        ペアリングのコードを承認する
#   scripts/relay.sh access             登録したルームと許可した人の一覧
#   scripts/relay.sh tunnel             LINE の Webhook を Cloudflare Quick Tunnel で公開する
#   scripts/relay.sh quota              LINE の今月の送信数
#   scripts/relay.sh webhook <種類> ... 署名付きの Webhook をローカルへ送る（開発用。scripts/webhook.ts）
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${RELAY_ENV_FILE:-$REPO_ROOT/.env}"
KEYS_FILE="$(dirname "$ENV_FILE")/.env.keys"
RELAY_LINE_PORT="${RELAY_LINE_PORT:-18080}"

die() { echo "error: $*" >&2; exit 1; }

require_dotenvx() { command -v dotenvx >/dev/null || die "dotenvx が見つかりません"; }

# public リポジトリに誤ってコミットしないよう、.env と .env.keys が git の無視対象か確かめる
ensure_ignored() {
  local f
  for f in "$ENV_FILE" "$KEYS_FILE"; do
    if git -C "$(dirname "$f")" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      && ! git -C "$(dirname "$f")" check-ignore -q "$f"; then
      die "$f が .gitignore の対象になっていません"
    fi
  done
}

# 値を .env に書き、そのキーだけをすぐ暗号化する。dotenvx set は値をコマンド引数で受け取るため使わない
store_value() {
  local key="$1" value="$2"
  [[ -n "$value" ]] || die "入力が空です"
  [[ "$value" =~ ^[A-Za-z0-9+/=._-]+$ ]] || die "想定外の文字が含まれています（前後の空白など）"
  touch "$ENV_FILE"
  sed -i '' "/^$key=/d" "$ENV_FILE"
  printf "%s='%s'\n" "$key" "$value" >>"$ENV_FILE"
  if ! dotenvx encrypt -f "$ENV_FILE" -k "$key" >/dev/null 2>&1 \
    || ! grep -q "^$key='encrypted:" "$ENV_FILE"; then
    sed -i '' "/^$key=/d" "$ENV_FILE"
    die "$key の暗号化に失敗したため、保存しませんでした"
  fi
}

cmd_secrets() {
  require_dotenvx
  ensure_ignored
  local secret token
  echo "LINE Developers コンソールの値を入力します。入力内容は画面に表示されません。"
  read -rsp "[1/2] チャネルシークレット: " secret; echo
  store_value RELAY_LINE_CHANNEL_SECRET "$secret"
  read -rsp "[2/2] チャネルアクセストークン（長期）: " token; echo
  store_value RELAY_LINE_CHANNEL_TOKEN "$token"
  echo "保存しました: ${ENV_FILE}"
}

# .env を復号して環境変数に入れてから、自分自身を呼び直す。既存の環境変数が優先される
with_env() {
  if [[ -z "${RELAY_ENV_LOADED:-}" && -f "$ENV_FILE" ]]; then
    require_dotenvx
    RELAY_ENV_LOADED=1 exec dotenvx run --quiet --strict -f "$ENV_FILE" -- "$0" "$@"
  fi
}

cd "$REPO_ROOT"
cmd="${1:-}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
  secrets) cmd_secrets ;;
  serve)
    with_env serve "$@"
    RELAY_HARNESS="${1:-${RELAY_HARNESS:-claude}}" exec mise exec -- bun src/main.ts serve
    ;;
  pair | access) exec mise exec -- bun src/main.ts "$cmd" "$@" ;;
  tunnel) exec mise exec -- cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$RELAY_LINE_PORT" ;;
  quota)
    with_env quota
    for path in quota quota/consumption; do
      printf '%s: ' "$path"
      # トークンをコマンド引数に載せないよう、ヘッダーはプロセス置換で渡す
      curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$RELAY_LINE_CHANNEL_TOKEN") "https://api.line.me/v2/bot/message/$path"
      echo
    done
    ;;
  webhook)
    with_env webhook "$@"
    exec mise exec -- bun scripts/webhook.ts "$@"
    ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
