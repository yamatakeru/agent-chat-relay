// リポジトリの検査（bun run check）。エージェントが繰り返した誤りを、CI で失敗させる（AGENTS.md の「規則と、それを強制するもの」）。
// 引数にディレクトリを渡すと、そこを検査する（過去のコミットで失敗することを確かめるため）
//
//   bun scripts/check.ts [root]

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

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

if (errors.length > 0) {
  for (const e of errors) console.error(e)
  process.exit(1)
}
