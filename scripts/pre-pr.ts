// PR を出す前の確認をまとめて走らせ、PR 本文の「確認」の下書きを標準出力に出す（ADR 0025）。
// テスト、検査、ミューテーションを走らせ、数と区分を実際の値で埋める。走らせる e2e を挙げ、結果の欄を作る。
// 何を埋め、どう書くかは、skill pre-pr（.agents/skills/pre-pr/SKILL.md）に書いてある。
// 起動するだけのファイルで、テストからは読み込まない。読み込むと、テストの中で bun test とミューテーションが入れ子に走る。
// 下書きを作る関数は scripts/pr-draft.ts に置き、テストはそちらを読み込む（#100）
//
//   bun run pre-pr [比べるコミット（既定は main）]

import { join } from "node:path"
import { BUN_ISOLATED } from "../src/harness/config.ts"
import { targetsSince } from "./e2e-targets.ts"
import { draft, parseMutation, testCounts } from "./pr-draft.ts"

function run(label: string, cmd: string[]): { ok: boolean; stdout: string; out: string } {
  console.error(`pre-pr: ${label}`)
  const r = Bun.spawnSync(cmd, { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  const stdout = r.stdout.toString()
  return { ok: r.exitCode === 0, stdout, out: `${stdout}${r.stderr.toString()}` }
}

const base = process.argv[2] ?? "main"
const rev = () => Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim()
const head = rev()
const test = run("bun test", [...BUN_ISOLATED, "test"])
const check = run("bun run check", [...BUN_ISOLATED, "run", "check"])
const mut = run("bun run mutation", ["sh", "scripts/mutation.sh", base, "--format", "json"])
const mutation = parseMutation(mut.stdout)
for (const [name, r] of [["bun test", test], ["bun run check", check]] as const) if (!r.ok) console.error(`\n== ${name} が失敗した ==\n${r.out}`)
if (!mutation) console.error(`\n== bun run mutation の結果を読めなかった ==\n${mut.out}`)
// 走らせている間にコミットが変わったら、どのコミットの結果か分からないので、下書きを出さない
if (rev() !== head) {
  console.error(`pre-pr: 走らせている間に、コミットが ${head} から ${rev()} に変わった。走らせ直す`)
  process.exit(1)
}
console.log(draft({ base, head, tests: testCounts(test.out), check: check.ok, mutation, e2e: targetsSince(base) }))
console.error("pre-pr: この下書きで PR 本文を書く。書き方は skill pre-pr（.agents/skills/pre-pr/SKILL.md）")
if (!test.ok || !check.ok || !mutation) process.exit(1)
