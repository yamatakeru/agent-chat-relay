#!/bin/sh
# 変更した行にミューテーションテストをかける（ADR 0021）。その前に、走らせる e2e を表示する（ADR 0023）。
# 使い方: bun run mutation [比べるコミット（既定は main）] [fallow mutation の引数...]
#         bun run mutation <ファイルかディレクトリ>... [fallow mutation の引数...]
# ファイルを渡すと、差分の行ではなく、そのファイル全体を変異させる。テストだけを足した PR で、守りたい行を確かめるときに使う。
# 変異させた関数が実際にファイルを書くので、HOME を .local の中に向け、終わったら消す
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
home="$root/.local/mutation-home"
paths=0
case ${1:-} in
  "" | -*) base=main ;;
  *) if [ -e "$1" ]; then base=main; paths=1; else base=$1; shift; fi ;;
esac
bun --no-env-file --config=/dev/null "$root/scripts/e2e-targets.ts" "$base"
mkdir -p "$home"
trap 'rm -rf "$home"' EXIT
# ファイルを渡したときは、差分の行に絞らない
[ "$paths" = 1 ] || set -- --changed-since "$base" "$@"
# fallow の npm のラッパーは node の shebang なので、Bun で、cwd の .env と bunfig.toml を読ませずに起動する
status=0
HOME="$home" bun --no-env-file --config=/dev/null "$root/node_modules/fallow/bin/fallow" mutation --allow-side-effects "$@" || status=$?
# PR を書く直前に読む場所なので、ここにも出す（AGENTS.md の「ミスの再発防止」の表）
echo
echo "PR の「確認できなかったこと」には、項目ごとに、確かめる手段、費用の見積もり（時間、実費）、確かめなかった理由を書く。"
echo "手元で数分、実費なしで確かめられるものは、書かずに確かめる。「確かめられない」と書くのは、手段がないことを示せるときだけ。"
exit "$status"
