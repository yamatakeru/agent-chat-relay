#!/usr/bin/env bash
# 評価：受信モードが「すべて」のルームで、メンションのない発言に、エージェントが答えるか・黙るか（#107。結果は docs/addressing-eval.md）。
# 案内（src/core/instructions.ts）を変えたら走らせる（scripts/e2e-targets.ts が挙げる）。
# 2 つの会話（main と holdout）を、それぞれ 3 回、並行して流し、基準に届かなければ 0 以外で終わる。
# 実際の Claude Code を動かすので、契約の利用枠を使う（Haiku で約 10 分）。モデルは ANTHROPIC_MODEL で選ぶ（なければ Claude Code の既定）
set -uo pipefail
cd "$(dirname "$0")/../.."
E=.local/e2e
mkdir -p "$E"
run() { mise exec -- bun --no-env-file --config=/dev/null test/e2e/addressing.ts run "$@"; }
run main --set main --port 18210 >"$E/addressing-main.out" 2>&1 &
run holdout --set holdout --port 18220 >"$E/addressing-holdout.out" 2>&1 &
wait
status=0
for set in main holdout; do
  mise exec -- bun --no-env-file --config=/dev/null test/e2e/addressing.ts report --check "$E/addressing-$set.json" || status=1
done
[ "$status" = 0 ] && echo "== すべての基準に届きました"
exit "$status"
