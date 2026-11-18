// docs/relay.md の ADR の一覧を、docs/adr/ の ADR から生成する。一覧に載せるのは、status が accepted のもの。
// 題名は ADR の見出し。bun run check は、一覧がこの生成と一致するかを確かめる
//
//   bun run docs:adr

import { readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const BEGIN = "<!-- ADR の一覧は docs/adr/ から生成する（bun run docs:adr）。手で書き換えない -->"
export const END = "<!-- ADR の一覧ここまで -->"

/** 生成した一覧（BEGIN と END の間に置く表） */
export function adrIndex(root: string): string {
  const dir = join(root, "docs/adr")
  const rows = readdirSync(dir)
    .filter((f) => /^\d{4}-.*\.md$/.test(f))
    .sort()
    .flatMap((f) => {
      const text = readFileSync(join(dir, f), "utf8")
      if (!/^status: accepted$/m.test(text)) return []
      const title = text.match(/^# (.+)$/m)?.[1]
      if (!title) throw new Error(`docs/adr/${f} に見出し（# ）がありません`)
      return [`| [${f.slice(0, 4)}](adr/${f}) | ${title} |`]
    })
  return ["| ADR | 内容 |", "|---|---|", ...rows].join("\n")
}

/** docs/relay.md の、BEGIN と END の間 */
export function currentIndex(doc: string): string | undefined {
  const b = doc.indexOf(BEGIN)
  const e = doc.indexOf(END)
  return b < 0 || e < b ? undefined : doc.slice(b + BEGIN.length, e).trim()
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..")
  const path = join(root, "docs/relay.md")
  const doc = readFileSync(path, "utf8")
  const current = currentIndex(doc)
  if (current === undefined) throw new Error(`docs/relay.md に「${BEGIN}」と「${END}」がありません`)
  writeFileSync(path, doc.replace(current, adrIndex(root)))
}
