// リポジトリの検査（bun run check）。エージェントが繰り返した誤りを、CI で失敗させる（AGENTS.md の「規則と、それを強制するもの」）。
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

/** 検査するファイル。ADR は記録なので対象外。AGENTS.md と GLOSSARY.md は、避ける語を例として書いている */
function files(patterns: string[], exclude: RegExp): string[] {
  const out = new Set<string>()
  for (const p of patterns) for (const f of new Bun.Glob(p).scanSync({ cwd: root, dot: true })) if (!exclude.test(f)) out.add(f)
  return [...out].sort()
}

function lines(file: string): string[] {
  return readFileSync(join(root, file), "utf8").split("\n")
}

const errors: string[] = []

for (const f of files(["{src,test,scripts,docs}/**/*.{ts,sh,md}", "README.md", ".github/**/*.yml", "bin/*"], /^docs\/adr\/|^scripts\/check\.ts$/)) {
  lines(f).forEach((line, n) => {
    for (const [re, use] of WORDING) if (re.test(line)) errors.push(`${f}:${n + 1}: 「${line.match(re)![0]}」ではなく「${use}」を使う（scripts/check.ts の WORDING）`)
  })
}

// Bun は、起動したディレクトリの .env を環境変数に読み込み、bunfig.toml の preload を実行する。
// 中継とスクリプトは、どちらも読ませずに起動する（ADR 0019。c3662b1、#18、#43、15efaa8 で繰り返した）
const ISOLATION = "--no-env-file --config=/dev/null"
const BUN_SCRIPT = /\bbun\s+((?:-\S+\s+)*)\S+\.ts\b/
for (const f of files(["**/*.sh", "bin/*", "package.json", ".github/**/*.yml"], /^(node_modules|\.local)\//)) {
  lines(f).forEach((line, n) => {
    const m = line.match(BUN_SCRIPT)
    if (m && !(m[1]!.includes("--no-env-file") && m[1]!.includes("--config=/dev/null")))
      errors.push(`${f}:${n + 1}: Bun でスクリプトを起動するときは「bun ${ISOLATION}」にする。中継の本体は bin/agent-chat-relay から起動する`)
  })
}
// TypeScript からは、src/harness/config.ts の BUN_ISOLATED で起動する。
// 例外は、その行に「分離の例外：理由（期限 YYYY-MM-DD、承認 名前）」を書く
const EXEC_PATH = /\[\s*process\.execPath\s*,(?!\s*["'`])/
const EXCEPTION = /分離の例外：.+（期限 (\d{4}-\d{2}-\d{2})、承認 \S+）/
const today = new Date().toISOString().slice(0, 10)
for (const f of files(["{src,test,scripts}/**/*.ts"], /^$/)) {
  lines(f).forEach((line, n) => {
    if (!EXEC_PATH.test(line)) return
    const ex = line.match(EXCEPTION)
    if (!ex) errors.push(`${f}:${n + 1}: Bun でスクリプトを起動するときは、src/harness/config.ts の BUN_ISOLATED を使う`)
    else if (ex[1]! < today) errors.push(`${f}:${n + 1}: 分離の例外の期限（${ex[1]}）が過ぎている。BUN_ISOLATED を使うか、例外を見直して期限を延ばす`)
  })
}

// docs/relay.md の ADR の一覧は、docs/adr/ から生成する（手で同期すると、ずれていた。0005 が抜けていた）
const current = currentIndex(readFileSync(join(root, "docs/relay.md"), "utf8"))
if (current === undefined) errors.push(`docs/relay.md: 「${BEGIN}」と「${END}」の間に ADR の一覧を置く`)
else if (current !== adrIndex(root)) errors.push("docs/relay.md: ADR の一覧が docs/adr/ と一致しない。bun run docs:adr を実行する")

if (errors.length > 0) {
  for (const e of errors) console.error(e)
  process.exit(1)
}
