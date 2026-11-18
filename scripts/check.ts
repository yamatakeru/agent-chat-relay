// リポジトリの検査（bun run check）。エージェントが繰り返したミスを、CI で失敗させる（AGENTS.md の、ミスの再発を防止するための規則の表）。
// 引数にディレクトリを渡すと、そこを検査する（過去のコミットで失敗することを確かめるため）
//
//   bun scripts/check.ts [root]

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
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
/** bun [フラグ] [run [フラグ]] <file>.ts。1 行に複数あれば、1 つずつ見る */
const BUN_SCRIPT = /\bbun\s+((?:-\S+\s+)*)(?:run\s+((?:-\S+\s+)*))?\S+\.ts\b/g

/** シェル・package.json・CI での Bun の起動 */
export function shellLaunchErrors(file: string, text: string): string[] {
  return text.split("\n").flatMap((line, n) =>
    [...line.matchAll(BUN_SCRIPT)]
      .map((m) => `${m[1]} ${m[2] ?? ""}`)
      .filter((flags) => !(flags.includes("--no-env-file") && flags.includes("--config=/dev/null")))
      .map(() => `${file}:${n + 1}: Bun でスクリプトを起動するときは「bun ${ISOLATION}」にする。中継の本体は bin/agent-chat-relay から起動する`),
  )
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

if (import.meta.main) {
  // 検査そのもののテスト（test/check.test.ts）は、避ける語と起動の例を含む
  const self = /^(scripts\/check\.ts|test\/check\.test\.ts)$/
  const errors: string[] = []
  for (const f of files(["{src,test,scripts,docs}/**/*.{ts,sh,md}", "README.md", "AGENTS.md", "GLOSSARY.md", ".github/**/*.yml", "bin/*"], /^docs\/adr\//))
    if (!self.test(f)) errors.push(...wordingErrors(f, read(f)))
  for (const f of files(["**/*.sh", "bin/*", "package.json", ".github/**/*.yml"], /^(node_modules|\.local)\//)) errors.push(...shellLaunchErrors(f, read(f)))
  const today = new Date().toISOString().slice(0, 10)
  for (const f of files(["{src,test,scripts}/**/*.ts"], self)) errors.push(...tsLaunchErrors(f, read(f), today))

  // docs/relay.md の ADR の一覧は、docs/adr/ から生成する（手で同期すると、ずれていた。0005 が抜けていた）
  const current = currentIndex(read("docs/relay.md"))
  if (current === undefined) errors.push(`docs/relay.md: 「${BEGIN}」と「${END}」の間に ADR の一覧を置く`)
  else if (current !== adrIndex(root)) errors.push("docs/relay.md: ADR の一覧が docs/adr/ と一致しない。bun run docs:adr を実行する")

  if (errors.length > 0) {
    for (const e of errors) console.error(e)
    process.exit(1)
  }
}
