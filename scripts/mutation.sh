#!/bin/sh
# 変更した行にミューテーションテストをかける（ADR 0021）。
# 使い方: bun run mutation [比べるコミット（既定は main）] [fallow mutation の引数...]
# 変異させた関数が実際にファイルを書くので、HOME を .local の中に向け、終わったら消す
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
home="$root/.local/mutation-home"
case ${1:-} in
  "" | -*) base=main ;;
  *) base=$1; shift ;;
esac
mkdir -p "$home"
trap 'rm -rf "$home"' EXIT
HOME="$home" "$root/node_modules/.bin/fallow" mutation --changed-since "$base" --allow-side-effects "$@"
