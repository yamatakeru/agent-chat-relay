# e2e の共通の部分（ADR 0023）。各スクリプトが source し、LOG（送信の記録）を決めてから使う。
# 引数：ハーネス名（既定は claude）と --full。--full を付けると、モデルの能力に頼る手順も走らせる。
# 各手順は check で判定し、最後の finish が、1 つでも失敗していれば 0 以外で終える。
# 失敗しても次の手順に進むのは、1 回の実行で、どの手順が通らないかをまとめて見るため

H=claude
FULL=0
for a in "$@"; do
  case $a in
    --full) FULL=1 ;;
    *) H=$a ;;
  esac
done
FAILED=()

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
# 送信の記録の n 行目より後に、パターンがあるか
sent_after() { tail -n "+$(($1 + 1))" "$LOG" | grep -- "$2" >/dev/null; } # -q だと grep が先に終わり、tail の SIGPIPE が pipefail で失敗になる
code() { grep -o 'relay pair [0-9a-f]\{6\}' "$LOG" | tail -1 | awk '{print $3}'; }
# 発言を送るコマンドを実行し、返ってきた登録のコードで、そのルームを登録する。pair_after <送るコマンド...>
pair_after() { local n; n="$(lines)"; "$@"; waitfor "$n" 15 && scripts/relay.sh pair "$(code)"; }

# 手順の結果を記録する。check <手順の名前> <判定のコマンド...>
check() {
  local name="$1"
  shift
  if "$@"; then echo "ok: $name"; else echo "NG: $name"; FAILED+=("$name"); fi
}
# モデルの能力に頼る手順（--full）。失敗しても、中継の退行とは限らない
check_model() {
  local name="$1"
  shift
  check "${name}（モデルの能力に頼る手順。中継の退行とは限らない）" "$@"
}
finish() {
  if [ "${#FAILED[@]}" -gt 0 ]; then
    echo "== 失敗した手順（${#FAILED[@]} 件）"
    printf -- '- %s\n' "${FAILED[@]}"
    exit 1
  fi
  echo "== すべての手順が通りました"
}
