// リポジトリの検査（bun run check）。エージェントが繰り返したミスを、CI で失敗させる（AGENTS.md の「ミスの再発防止」の表）。
// 引数にディレクトリを渡すと、そこを検査する（過去のコミットで失敗することを確かめるため）
//
//   bun scripts/check.ts [root]

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { BUN_ISOLATED } from "../src/harness/config.ts"
import { adrIndex, BEGIN, currentIndex, END } from "./adr-index.ts"

const root = resolve(process.argv[2] ?? join(import.meta.dir, ".."))

/** 取り除いた言い回しと、代わりに使う語（#20・#22）。「版」は「Web 版」「縮小版」などの正しい用法があるので含めない */
const WORDING: [RegExp, string][] = [
  [/受け口/, "エンドポイント"],
  [/定期取得/, "ポーリング"],
  [/要[るらりれ]/, "必要（必要だ、必要ない、など）"],
  [/送り主/, "送信者"],
  [/入れ方/, "インストール方法"],
]

/** 検査するファイル。ADR は記録なので対象外 */
function files(patterns: string[], exclude: RegExp): string[] {
  const out = new Set<string>()
  for (const p of patterns) for (const f of new Bun.Glob(p).scanSync({ cwd: root, dot: true })) if (!exclude.test(f)) out.add(f)
  return [...out].sort()
}

function read(file: string): string {
  return readFileSync(join(root, file), "utf8")
}

/** 取り除いた言い回し */
export function wordingErrors(file: string, text: string): string[] {
  return text.split("\n").flatMap((line, n) =>
    WORDING.filter(([re]) => re.test(line)).map(([re, use]) => `${file}:${n + 1}: 「${line.match(re)![0]}」ではなく「${use}」を使う（scripts/check.ts の WORDING）`),
  )
}

// Bun は、起動したディレクトリの .env を環境変数に読み込み、bunfig.toml の preload を実行する。
// 中継とスクリプトは、どちらも読ませずに起動する（ADR 0019。c3662b1、#18、#43、15efaa8 で繰り返した）
const ISOLATION = "--no-env-file --config=/dev/null"
/**
 * シェル・package.json・CI での Bun の起動。起動の形（フラグの位置、run、ほかのオプション）は見分けない。
 * 継続行（行末の \）をつないだ 1 つのコマンドの中で、bun と .ts のファイルがあれば、bun ごとに分離のフラグを求める
 */
export function shellLaunchErrors(file: string, text: string): string[] {
  const lines = text.split("\n")
  const errors: string[] = []
  for (let n = 0; n < lines.length; n++) {
    const start = n
    let command = lines[n]!
    while (command.endsWith("\\") && n + 1 < lines.length) command = command.slice(0, -1) + " " + lines[++n]
    // && や ; でつないだ起動は、1 つずつ見る
    for (const part of command.split(/&&|\|\||;|\|/)) {
      if (!/\bbun\b/.test(part) || !/\S\.ts\b/.test(part)) continue
      if (!(part.includes("--no-env-file") && part.includes("--config=/dev/null")))
        errors.push(`${file}:${start + 1}: Bun でスクリプトを起動するときは「bun ${ISOLATION}」にする。中継の本体は bin/agent-chat-relay から起動する`)
    }
  }
  return errors
}

// TypeScript からは、src/harness/config.ts の BUN_ISOLATED で起動する。process.execPath は、そこでだけ使う。
// 例外は、その行に「分離の例外：理由（期限 YYYY-MM-DD、承認 名前）」を書く
const EXCEPTION = /分離の例外：.+（期限 (\d{4}-\d{2}-\d{2})、承認 \S+）/

function isDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

/** TypeScript での process.execPath（BUN_ISOLATED を通さない Bun の起動） */
export function tsLaunchErrors(file: string, text: string, today: string): string[] {
  if (file === "src/harness/config.ts") return []
  return text.split("\n").flatMap((line, n) => {
    if (!line.includes("process.execPath")) return []
    const ex = line.match(EXCEPTION)
    if (!ex) return [`${file}:${n + 1}: Bun でスクリプトを起動するときは、src/harness/config.ts の BUN_ISOLATED を使う`]
    if (!isDate(ex[1]!)) return [`${file}:${n + 1}: 分離の例外の期限（${ex[1]}）が日付ではない`]
    if (ex[1]! < today) return [`${file}:${n + 1}: 分離の例外の期限（${ex[1]}）が過ぎている。BUN_ISOLATED を使うか、例外を見直して期限を延ばす`]
    return []
  })
}

// fallow は、入口から読まれないファイルの変異を dead code として外し、ミューテーションの報告の数に入れない。
// 入口は package.json の main（シェルの bin/agent-chat-relay）だけと見るので、子プロセスで動く src/main.ts も外れていた（#92）。
// 外された変異は、テストが届かないもの（none-file）として報告させる（ADR 0021）
type MutationPlan = { mutants?: { file: string; prune_reason?: string | null }[] }

/** fallow が dead code として外す変異のファイル */
export function prunedErrors(plan: MutationPlan): string[] {
  const counts = new Map<string, number>()
  for (const m of plan.mutants ?? []) if (m.prune_reason === "dead-code") counts.set(m.file, (counts.get(m.file) ?? 0) + 1)
  return [...counts].map(
    ([file, n]) =>
      `${file}: fallow が変異 ${n} 個を dead code として外し、bun run mutation の報告の数に入れていない。bun や子プロセスで直接動かすファイルなら、.fallowrc.json の entry に足す。使っていないコードなら消す（ADR 0021）`,
  )
}

function mutationPlan(): MutationPlan {
  const fallow = join(import.meta.dir, "../node_modules/fallow/bin/fallow")
  const r = Bun.spawnSync([...BUN_ISOLATED, fallow, "mutation", "--all", "--plan", "--allow-side-effects", "--format", "json"], { cwd: root })
  const out = r.stdout.toString()
  if (r.exitCode !== 0 || !out.includes("{")) throw new Error(`fallow mutation --plan が失敗した：${r.stderr.toString()}`)
  return JSON.parse(out.slice(out.indexOf("{")))
}

if (import.meta.main) {
  // 検査そのもののテスト（test/check.test.ts）は、避ける語と起動の例を含む
  const self = /^(scripts\/check\.ts|test\/check\.test\.ts)$/
  const errors: string[] = []
  for (const f of files(["{src,test,scripts,docs}/**/*.{ts,sh,md}", ".agents/**/*.md", "README.md", "AGENTS.md", "CLAUDE.md", "GLOSSARY.md", ".github/**/*.yml", "bin/*"], /^docs\/adr\//))
    if (!self.test(f)) errors.push(...wordingErrors(f, read(f)))
  for (const f of files(["**/*.sh", "bin/*", "package.json", ".github/**/*.yml"], /^(node_modules|\.local)\//)) errors.push(...shellLaunchErrors(f, read(f)))
  const today = new Date().toISOString().slice(0, 10)
  for (const f of files(["{src,test,scripts}/**/*.ts"], self)) errors.push(...tsLaunchErrors(f, read(f), today))

  // docs/relay.md の ADR の一覧は、docs/adr/ から生成する（手で同期すると、ずれていた。0005 が抜けていた）
  const current = currentIndex(read("docs/relay.md"))
  if (current === undefined) errors.push(`docs/relay.md: 「${BEGIN}」と「${END}」の間に ADR の一覧を置く`)
  else if (current !== adrIndex(root)) errors.push("docs/relay.md: ADR の一覧が docs/adr/ と一致しない。bun run docs:adr を実行する")

  errors.push(...prunedErrors(mutationPlan()))

  if (errors.length > 0) {
    for (const e of errors) console.error(e)
    process.exit(1)
  }
}
