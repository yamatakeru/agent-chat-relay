// 変更から、走らせる e2e を挙げる（ADR 0023）。bun run mutation が変異の前に表示し、bun run pre-pr が PR 本文の下書きに入れる。
// e2e は、ハーネスとの結合（実際の Claude Code が承認を求めて答えに従うこと、MCP、再開）を確かめるので、
// その結合に関わるパスと依存を変えたときだけ挙げる。コネクターと src/core/relay.ts は、単体テストで守る
//
//   bun scripts/e2e-targets.ts [比べるコミット（既定は main）]

/**
 * e2e の中核（ADR 0023）。line.sh は --full を付けないと、モデルの能力に頼る手順を走らせない。
 * 中核は、結合に関わる変更とリリースのたびに走り、時間と実費がかかる。足すのは、実際のハーネスでしか確かめられず、
 * 壊れると安全境界が破れるものだけ。それ以外は、単体テストで守るか、OPTIONAL に置く（#92 で、知らせの e2e を中核に足して外した。ADR 0024）
 */
export const CORE = ["test/e2e/line.sh claude", "test/e2e/resume.sh claude"]
/** 中核の外の e2e。そのスクリプトか、それが使うモックと共通の部分を変えたときだけ挙げる（Chatwork は ADR 0023、知らせは ADR 0024） */
const OPTIONAL = [
  { script: "test/e2e/chatwork.sh claude", paths: [/^test\/e2e\/(chatwork\.sh|mock-chatwork\.ts|lib\.sh)$/] },
  { script: "test/e2e/notices.sh claude", paths: [/^test\/e2e\/(notices\.sh|mock-line\.ts|lib\.sh)$/] },
]

/** ハーネスとの結合に関わるパス */
const CORE_PATHS = [
  /^src\/harness\//,
  /^src\/core\/mcp\.ts$/,
  /^src\/prompt\.ts$/,
  /^src\/(main|workspace|home|serve-args)\.ts$/,
  /^bin\//,
  /^test\/e2e\/(?!chatwork\.sh$|mock-chatwork\.ts$|notices\.sh$)/,
]
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
  const optional = OPTIONAL.map(({ script, paths }) => ({ script, reasons: files.filter((f) => paths.some((r) => r.test(f))) }))
  return [...(core.length ? CORE.map((script) => ({ script, reasons: core })) : []), ...optional.filter((t) => t.reasons.length)]
}

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stderr: "inherit" })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} が失敗しました`)
  return r.stdout.toString()
}

/** base との差分（コミットしていない変更と、追跡していないファイルも含める）から、走らせる e2e を返す */
export function targetsSince(base: string): Target[] {
  const from = git("merge-base", base, "HEAD").trim()
  const files = [...git("diff", "--name-only", from).split("\n"), ...git("ls-files", "--others", "--exclude-standard").split("\n")].filter(Boolean)
  return e2eTargets(files, git("diff", from, "--", "package.json", "bun.lock"))
}

if (import.meta.main) {
  const targets = targetsSince(process.argv[2] ?? "main")
  if (!targets.length) console.log("e2e: 走らせる必要はありません（ハーネスとの結合に関わる変更がない。ADR 0023）")
  else {
    console.log("e2e: 次を走らせ、結果を PR に書いてください（ADR 0023）")
    for (const t of targets) console.log(`  ${t.script}\n    理由: ${t.reasons.join("、")}`)
  }
}
