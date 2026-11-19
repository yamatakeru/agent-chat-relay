#!/bin/sh
# 変更した行にミューテーションテストをかける（ADR 0021）。その前に、走らせる e2e を表示する（ADR 0023）。
# 使い方: bun run mutation [比べるコミット（既定は main）] [fallow mutation の引数...]
#         bun run mutation <ファイルかディレクトリ>... [fallow mutation の引数...]
# ファイルを渡すと、差分の行ではなく、そのファイル全体を変異させる。テストだけを足した PR で、守りたい行を確かめるときに使う。
# 変異させた関数が実際にファイルを書くので、HOME を .local の中に向け、終わったら消す
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
home="$root/.local/mutation-home"
scope=changed
case ${1:-} in
  "" | -*) base=main ;;
  *) if [ -e "$1" ]; then base=main; scope=paths; else base=$1; shift; fi ;;
esac
bun --no-env-file --config=/dev/null "$root/scripts/e2e-targets.ts" "$base"
mkdir -p "$home"
trap 'rm -rf "$home"' EXIT
# fallow の npm のラッパーは node の shebang なので、Bun で、cwd の .env と bunfig.toml を読ませずに起動する
if [ "$scope" = paths ]; then
  HOME="$home" bun --no-env-file --config=/dev/null "$root/node_modules/fallow/bin/fallow" mutation --allow-side-effects "$@"
else
  HOME="$home" bun --no-env-file --config=/dev/null "$root/node_modules/fallow/bin/fallow" mutation --changed-since "$base" --allow-side-effects "$@"
fi
