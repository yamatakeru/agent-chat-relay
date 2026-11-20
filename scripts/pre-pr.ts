// PR を出す前の確認をまとめて走らせ、PR 本文の「確認」の下書きを標準出力に出す（ADR 0025）。
// テスト、検査、ミューテーションを走らせ、数と区分を実際の値で埋める。走らせる e2e を挙げ、結果の欄を作る。
// 何を埋め、どう書くかは、skill pre-pr（.agents/skills/pre-pr/SKILL.md）に書いてある
//
//   bun run pre-pr [比べるコミット（既定は main）]

import { join } from "node:path"
import { BUN_ISOLATED } from "../src/harness/config.ts"
import { type Target, targetsSince } from "./e2e-targets.ts"

type Mutant = { file: string; line: number; status: string; operator: string; change: { from: string; to: string }; test_reach?: { reach: string } | null; prune_reason?: string | null }
export type Mutation = { summary: { counts: Record<string, number> }; mutants: Mutant[] }
export type Results = { base: string; head: string; tests: { pass: number; fail: number } | undefined; check: boolean; mutation: Mutation | undefined; e2e: Target[] }

/** 状態の名前。ここにない状態も、そのままの名前で挙げる（fallow は状態を増やしうる） */
const STATUS: Record<string, string> = {
  killed: "捕まえた",
  timeout: "時間切れ（捕まえたものとして数える）",
  survived: "生き残り",
  no_coverage: "テストが届かない",
}
/** 捕まえたもの。これ以外の状態は、ひとつずつ扱いを書く */
const CAUGHT = new Set(["killed", "timeout"])

/** bun test の出力から、通った数と失敗した数を読む */
export function testCounts(out: string): { pass: number; fail: number } | undefined {
  const pass = out.match(/^\s*(\d+) pass$/m)
  const fail = out.match(/^\s*(\d+) fail$/m)
  return pass && fail ? { pass: Number(pass[1]), fail: Number(fail[1]) } : undefined
}

/** 捕まえていない変異をまとめる単位。生き残りは 1 つずつ、それ以外はファイルと区分ごと */
function groupOf(x: Mutant): string {
  if (x.status === "survived") return `\`${x.file}:${x.line}\`（${STATUS.survived}。${x.operator} \`${x.change.from}\` → \`${x.change.to}\`）`
  const kind = x.test_reach ? `区分 ${x.test_reach.reach}` : x.prune_reason ? `理由 ${x.prune_reason}` : "区分なし"
  return `\`${x.file}\`（${STATUS[x.status] ?? x.status}。${kind}）`
}

function mutationLines(m: Mutation): string[] {
  const total = m.summary.counts.total
  if (!total) return ["- `bun run mutation`：変異 0 個（変えた行に、変異させる箇所がない）"]
  const counts = Object.entries(m.summary.counts).filter(([k, n]) => k !== "total" && n)
  const lines = [`- \`bun run mutation\`：変異 ${total} 個のうち、${counts.map(([k, n]) => `${STATUS[k] ?? k} ${n} 個`).join("、")}`]
  const rest = m.mutants.filter((x) => !CAUGHT.has(x.status))
  if (!rest.length) return lines
  lines.push("  - 捕まえていない変異。テストで捕まえるか、捕まえない理由を書く：")
  const groups = new Map<string, number>()
  for (const key of rest.map(groupOf)) groups.set(key, (groups.get(key) ?? 0) + 1)
  for (const [key, n] of groups) lines.push(`    - ${key} ${n} 個：（理由）`)
  return lines
}

/** PR 本文の「確認」と「確認できなかったこと」の下書き */
export function draft(r: Results): string {
  const lines = [
    "## 確認",
    "",
    `<!-- bun run pre-pr が、コミット ${r.head} で、${r.base} との差分から書いた下書き。数と区分は実際の値なので、書き換えない。（）を埋める -->`,
    r.tests ? `- \`bun test\`：${r.tests.pass} 件が通った。失敗 ${r.tests.fail} 件` : "- `bun test`：結果を読めなかった",
    `- \`bun run check\`：${r.check ? "通った" : "失敗した"}`,
    ...(r.mutation ? mutationLines(r.mutation) : ["- `bun run mutation`：結果を読めなかった"]),
    r.e2e.length ? "- e2e（ADR 0023）：" : "- e2e：挙げられなかった（ハーネスとの結合に関わる変更がない。ADR 0023）",
    ...r.e2e.map((t) => `  - \`${t.script}\`：（結果。モデル）`),
    "- simplify：（最後の変更のあとにかけたか。何を直したか）",
    "- レビュー：（最後の変更のあとにかけたか。指摘の数と対応）",
    "",
    "## 確認できなかったこと",
    "",
    "- **（項目）**：手段：（）。費用：（時間、実費）。確かめなかった理由：（）",
  ]
  return `${lines.join("\n")}\n`
}

/** bun run mutation --format json の標準出力から、結果を読む。読めなければ undefined（fallow のエラーも JSON で返る） */
export function parseMutation(stdout: string): Mutation | undefined {
  try {
    // 形が違えば（null、summary がない、など）、ここで投げて undefined を返す
    const parsed = JSON.parse(stdout)
    return parsed.summary.counts && Array.isArray(parsed.mutants) ? parsed : undefined
  } catch {
    return undefined
  }
}

function run(label: string, cmd: string[]): { ok: boolean; stdout: string; out: string } {
  console.error(`pre-pr: ${label}`)
  const r = Bun.spawnSync(cmd, { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" })
  const stdout = r.stdout.toString()
  return { ok: r.exitCode === 0, stdout, out: `${stdout}${r.stderr.toString()}` }
}

if (import.meta.main) {
  const base = process.argv[2] ?? "main"
  const test = run("bun test", [...BUN_ISOLATED, "test"])
  const check = run("bun run check", [...BUN_ISOLATED, "run", "check"])
  const mut = run("bun run mutation", ["sh", "scripts/mutation.sh", base, "--format", "json"])
  const mutation = parseMutation(mut.stdout)
  for (const [name, r] of [["bun test", test], ["bun run check", check]] as const) if (!r.ok) console.error(`\n== ${name} が失敗した ==\n${r.out}`)
  if (!mutation) console.error(`\n== bun run mutation の結果を読めなかった ==\n${mut.out}`)
  const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]).stdout.toString().trim()
  console.log(draft({ base, head, tests: testCounts(test.out), check: check.ok, mutation, e2e: targetsSince(base) }))
  console.error("pre-pr: この下書きで PR 本文を書く。書き方は skill pre-pr（.agents/skills/pre-pr/SKILL.md）")
  if (!test.ok || !check.ok || !mutation) process.exit(1)
}
