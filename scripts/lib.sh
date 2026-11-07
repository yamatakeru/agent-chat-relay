# shellcheck shell=bash
# scripts/line-native.sh と scripts/line.sh が共有する関数。単独では実行しない。
# 呼び出し側で REPO_ROOT、ENV_FILE、KEYS_FILE、CCJ_LINE_PORT を設定してから source する。
# 秘密情報は dotenvx で暗号化したリポジトリ直下の .env に置く。平文の秘密をコマンド引数や履歴に残さない。

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

# 値を .env に書き、そのキーだけをすぐ暗号化する。
# dotenvx set は値をコマンド引数で受け取るため、秘密には使わない
store_value() {
  local key="$1" value="$2"
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

store_secret() {
  local key="$1" label="$2" value
  read -rsp "$label: " value
  echo
  store_value "$key" "$value"
}

# public リポジトリに誤ってコミットしないよう、.env と .env.keys が git の無視対象か確かめる
ensure_ignored() {
  local f dir
  for f in "$ENV_FILE" "$KEYS_FILE"; do
    dir="$(dirname "$f")"
    if git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
      && ! git -C "$dir" check-ignore -q "$f"; then
      die "$f が .gitignore の対象になっていません"
    fi
  done
}

cmd_secrets() {
  require_dotenvx
  ensure_ignored
  echo "LINE Developers コンソールの値を入力します。入力内容は画面に表示されません。"
  store_secret CCJ_LINE_CHANNEL_SECRET "[1/2] チャネルシークレット"
  store_secret CCJ_LINE_CHANNEL_TOKEN "[2/2] チャネルアクセストークン（長期）"
  echo "保存しました: ${ENV_FILE}（復号鍵: ${KEYS_FILE}）"
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
  ensure_ignored
  dotenvx set CCJ_LINE_ALLOW_FROM "$ids" -f "$ENV_FILE" >/dev/null 2>&1 || die "保存に失敗しました"
  echo "許可する userId を ${#list[@]} 件保存しました。再起動すると反映されます。"
}

cmd_tunnel() {
  # リポジトリの mise.toml で固定した版を使うため、リポジトリで実行する
  cd "$REPO_ROOT" || die "cd に失敗しました"
  exec mise exec -- cloudflared tunnel --no-autoupdate --url "http://localhost:$CCJ_LINE_PORT"
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

# リポジトリ内（.local/tmp/）に一時ファイルを作り、スクリプトの終了時に消す。失敗で途中終了しても消える
make_tmp() {
  mkdir -p "$REPO_ROOT/.local/tmp"
  CCJ_TMP_FILE="$(mktemp "$REPO_ROOT/.local/tmp/webhook.XXXXXX")"
  trap 'rm -f "$CCJ_TMP_FILE"' EXIT
}

# 本文を X-Line-Signature 付きでローカルの受け口へ送る。秘密は環境変数経由で渡す
post_signed_webhook() {
  local body="$1" times="$2" bad="$3" secret sig i
  if [[ "$bad" == 1 ]]; then
    secret="definitely-not-the-channel-secret"
  else
    secret="$(secret_value CCJ_LINE_CHANNEL_SECRET)"
  fi
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
