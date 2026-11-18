// scripts/check.ts と scripts/adr-index.ts の検査が、ミスを見逃さないこと
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { adrIndex, BEGIN, currentIndex, END, replaceIndex } from "../scripts/adr-index.ts"
import { shellLaunchErrors, tsLaunchErrors, wordingErrors } from "../scripts/check.ts"

const TODAY = "2026-11-19"

test("取り除いた言い回しは、活用した形も見つけ、代わりの語を示す", () => {
  expect(wordingErrors("a.md", "x\n中身が要らないなら")).toEqual(["a.md:2: 「要ら」ではなく「必要（必要だ、必要ない、など）」を使う（scripts/check.ts の WORDING）"])
  expect(wordingErrors("a.md", "必要ない。重要だ")).toEqual([])
})

test("シェルからの Bun の起動は、bun run の形でも、フラグが片方だけでも見つける", () => {
  const bad = ["bun scripts/a.ts", "bun run scripts/a.ts", "bun --no-env-file scripts/a.ts", "bun run --config=/dev/null scripts/a.ts", "mise exec -- bun test/e2e/mock.ts x"]
  for (const line of bad) expect(shellLaunchErrors("a.sh", line)).toHaveLength(1)
  expect(shellLaunchErrors("package.json", "bun --no-env-file --config=/dev/null scripts/a.ts && bun scripts/b.ts")).toHaveLength(1)
  expect(shellLaunchErrors("a.sh", "x\nbun \\\n  scripts/a.ts")).toEqual([
    "a.sh:2: Bun でスクリプトを起動するときは「bun --no-env-file --config=/dev/null」にする。中継の本体は bin/agent-chat-relay から起動する",
  ])
  expect(shellLaunchErrors("a.sh", "bun --cwd ./work scripts/a.ts")).toHaveLength(1)
  expect(shellLaunchErrors("a.sh", "bun --no-env-file \\\n  --config=/dev/null scripts/a.ts")).toEqual([])
  const good = ["bun --no-env-file --config=/dev/null scripts/a.ts", "bun run --no-env-file --config=/dev/null scripts/a.ts", "bun --no-env-file run --config=/dev/null scripts/a.ts", "bun run check", "bun test"]
  for (const line of good) expect(shellLaunchErrors("a.sh", line)).toEqual([])
})

test("TypeScript では、process.execPath を src/harness/config.ts の外で使うと、どんな形でも見つける", () => {
  for (const code of ["Bun.spawn([process.execPath, script])", 'Bun.spawn([process.execPath, "scripts/a.ts"])', 'Bun.spawnSync([process.execPath, "pm", "pack"])', "const bun = process.execPath"])
    expect(tsLaunchErrors("a.ts", code, TODAY)).toHaveLength(1)
  expect(tsLaunchErrors("a.ts", "x\nBun.spawn([\n  process.execPath,\n  script,\n])", TODAY)).toEqual([
    "a.ts:3: Bun でスクリプトを起動するときは、src/harness/config.ts の BUN_ISOLATED を使う",
  ])
  expect(tsLaunchErrors("a.ts", "Bun.spawn([...BUN_ISOLATED, script])", TODAY)).toEqual([])
  expect(tsLaunchErrors("src/harness/config.ts", "export const BUN_ISOLATED = [process.execPath]", TODAY)).toEqual([])
})

test("分離の例外は、期限が過ぎたもの、日付でないものを通さない", () => {
  const launch = (expiry: string) => `Bun.spawn([\n  process.execPath, // 分離の例外：対照（期限 ${expiry}、承認 someone）\n  script,\n])`
  expect(tsLaunchErrors("a.ts", launch("2026-11-19"), TODAY)).toEqual([])
  expect(tsLaunchErrors("a.ts", launch("2026-11-18"), TODAY)).toEqual(["a.ts:2: 分離の例外の期限（2026-11-18）が過ぎている。BUN_ISOLATED を使うか、例外を見直して期限を延ばす"])
  expect(tsLaunchErrors("a.ts", launch("2026-19-01"), TODAY)).toEqual(["a.ts:2: 分離の例外の期限（2026-19-01）が日付ではない"])
  expect(tsLaunchErrors("a.ts", "Bun.spawn([process.execPath, s]) // 分離の例外：対照", TODAY)).toHaveLength(1)
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(import.meta.dir, "..", ".local", "test-check-"))
  mkdirSync(join(dir, "docs/adr"), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test("ADR の一覧には、front matter の status が accepted のものだけを、見出しを題名にして載せる", () => {
  writeFileSync(join(dir, "docs/adr/0001-a.md"), "---\nstatus: accepted\n---\n\n# A を使う\n")
  writeFileSync(join(dir, "docs/adr/0002-b.md"), "---\nstatus: superseded by ADR 0003\n---\n\n# B を使う\n\n```\nstatus: accepted\n```\n")
  expect(adrIndex(dir)).toBe("| ADR | 内容 |\n|---|---|\n| [0001](adr/0001-a.md) | A を使う |")
})

test("ADR の一覧は、目印の間だけを置き換える。間が空でも、外は変えない", () => {
  const doc = `前\n\n| 古い表 |\n\n${BEGIN}\n${END}\n\n後\n`
  const next = replaceIndex(doc, "| 新しい表 |")!
  expect(next).toBe(`前\n\n| 古い表 |\n\n${BEGIN}\n\n| 新しい表 |\n\n${END}\n\n後\n`)
  expect(currentIndex(next)).toBe("| 新しい表 |")
  expect(replaceIndex("目印なし", "x")).toBeUndefined()
})
