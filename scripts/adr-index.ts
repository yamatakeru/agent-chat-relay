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
      // status は、先頭の front matter の中だけを見る
      const meta = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? ""
      if (!/^status: accepted$/m.test(meta)) return []
      const title = text.match(/^# (.+)$/m)?.[1]
      if (!title) throw new Error(`docs/adr/${f} に見出し（# ）がありません`)
      return [`| [${f.slice(0, 4)}](adr/${f}) | ${title} |`]
    })
  return ["| ADR | 内容 |", "|---|---|", ...rows].join("\n")
}

function markers(doc: string): [number, number] | undefined {
  const b = doc.indexOf(BEGIN)
  const e = doc.indexOf(END)
  return b < 0 || e < b ? undefined : [b + BEGIN.length, e]
}

/** docs/relay.md の、BEGIN と END の間 */
export function currentIndex(doc: string): string | undefined {
  const m = markers(doc)
  return m && doc.slice(m[0], m[1]).trim()
}

/** BEGIN と END の間を、index に置き換える。間の外は変えない */
export function replaceIndex(doc: string, index: string): string | undefined {
  const m = markers(doc)
  return m && `${doc.slice(0, m[0])}\n\n${index}\n\n${doc.slice(m[1])}`
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..")
  const path = join(root, "docs/relay.md")
  const next = replaceIndex(readFileSync(path, "utf8"), adrIndex(root))
  if (next === undefined) throw new Error(`docs/relay.md に「${BEGIN}」と「${END}」がありません`)
  writeFileSync(path, next)
}
