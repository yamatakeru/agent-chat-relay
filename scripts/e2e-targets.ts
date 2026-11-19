// 変更から、走らせる e2e を挙げる（ADR 0023）。bun run mutation が、変異の前に表示する。
// e2e は、ハーネスとの結合（実際の Claude Code が承認を求めて答えに従うこと、MCP、再開）を確かめるので、
// その結合に関わるパスと依存を変えたときだけ挙げる。コネクターと src/core/relay.ts は、単体テストで守る
//
//   bun scripts/e2e-targets.ts [比べるコミット（既定は main）]

/** e2e の中核（ADR 0023）。line.sh は --full を付けないと、モデルの能力に頼る手順を走らせない */
export const CORE = ["test/e2e/line.sh claude", "test/e2e/resume.sh claude"]
const CHATWORK = "test/e2e/chatwork.sh claude"

/** ハーネスとの結合に関わるパス */
const CORE_PATHS = [
  /^src\/harness\//,
  /^src\/core\/mcp\.ts$/,
  /^src\/prompt\.ts$/,
  /^src\/(main|workspace|home|serve-args)\.ts$/,
  /^bin\//,
  /^test\/e2e\/(?!chatwork\.sh$|mock-chatwork\.ts$)/,
]
const CHATWORK_PATHS = [/^test\/e2e\/(chatwork\.sh|mock-chatwork\.ts|lib\.sh)$/]
/** ハーネス（アダプター）と ACP・MCP の SDK。package.json と bun.lock の差分の行に現れる名前 */
const CORE_DEPS = /@agentclientprotocol\/|@modelcontextprotocol\/|@anthropic-ai\/claude/

export type Target = { script: string; reasons: string[] }

/**
 * 変更したファイルと、package.json・bun.lock の差分から、走らせる e2e と、その理由を返す
 * @param depDiff package.json と bun.lock の差分（git diff の出力）
 */
export function e2eTargets(files: string[], depDiff: string): Target[] {
  const core = files.filter((f) => CORE_PATHS.some((r) => r.test(f)))
  const deps = depDiff
    .split("\n")
    .filter((l) => /^[+-](?![+-])/.test(l) && CORE_DEPS.test(l))
    .map((l) => l.match(CORE_DEPS)![0].replace(/\/$/, ""))
  if (deps.length) core.push(`依存（${[...new Set(deps)].join("、")}）`)
  const chatwork = files.filter((f) => CHATWORK_PATHS.some((r) => r.test(f)))
  return [
    ...(core.length ? CORE.map((script) => ({ script, reasons: core })) : []),
    ...(chatwork.length ? [{ script: CHATWORK, reasons: chatwork }] : []),
  ]
}

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stderr: "inherit" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} が失敗しました`)
  return r.stdout.toString()
}

if (import.meta.main) {
  // コミットしていない変更と、追跡していないファイルも含める
  const from = git("merge-base", process.argv[2] ?? "main", "HEAD").trim()
  const files = [...git("diff", "--name-only", from).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean)
  const targets = e2eTargets(files, git("diff", from, "--", "package.json", "bun.lock"))
  if (!targets.length) console.log("e2e: 走らせる必要はありません（ハーネスとの結合に関わる変更がない。ADR 0023）")
  else {
    console.log("e2e: 次を走らせ、結果を PR に書いてください（ADR 0023）")
    for (const t of targets) console.log(`  ${t.script}\n    理由: ${t.reasons.join("、")}`)
  }
}
