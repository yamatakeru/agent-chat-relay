// scripts/check.ts と scripts/adr-index.ts の検査が、ミスを見逃さないこと。e2e を走らせる判定（scripts/e2e-targets.ts と test/e2e/lib.sh）
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { adrIndex, BEGIN, currentIndex, END, replaceIndex } from "../scripts/adr-index.ts"
import { shellLaunchErrors, tsLaunchErrors, wordingErrors } from "../scripts/check.ts"
import { CORE, e2eTargets } from "../scripts/e2e-targets.ts"
import { BUN_ISOLATED } from "../src/harness/config.ts"

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

test("ハーネスとの結合に関わるパスを変えたら、e2e の中核を、理由のパスと一緒に挙げる", () => {
  for (const f of ["src/harness/harness.ts", "src/core/mcp.ts", "src/prompt.ts", "src/main.ts", "src/workspace.ts", "src/home.ts", "src/serve-args.ts", "bin/agent-chat-relay", "test/e2e/line.sh", "test/e2e/lib.sh"]) {
    expect(e2eTargets([f, "README.md"], "").filter((t) => CORE.includes(t.script))).toEqual(CORE.map((script) => ({ script, reasons: [f] })))
  }
  expect(CORE).toEqual(["test/e2e/line.sh claude", "test/e2e/resume.sh claude"])
  // パスは、先頭から末尾まで一致したものだけ
  const near = ["docs/src/harness/a.md", "x/src/core/mcp.ts", "src/core/mcp.tsx", "x/src/prompt.ts", "src/prompt.ts.orig", "x/src/main.ts", "src/main.tsx", "x/bin/a", "x/test/e2e/line.sh", "x/test/e2e/chatwork.sh"]
  expect(e2eTargets(near, "")).toEqual([])
  for (const f of ["test/e2e/chatwork.sh.orig", "test/e2e/mock-chatwork.ts.orig", "test/e2e/notices.sh.orig"]) expect(e2eTargets([f], "").map((t) => t.script)).toEqual(CORE)
})

test("コネクター・src/core/relay.ts・文書だけの変更では、e2e を挙げない。Chatwork と知らせの e2e は、その e2e を変えたときだけ挙げる", () => {
  expect(e2eTargets(["src/core/relay.ts", "src/core/access.ts", "src/connectors/line.ts", "src/connectors/chatwork.ts", "docs/relay.md", "test/relay.test.ts"], "")).toEqual([])
  expect(e2eTargets(["test/e2e/chatwork.sh"], "")).toEqual([{ script: "test/e2e/chatwork.sh claude", reasons: ["test/e2e/chatwork.sh"] }])
  expect(e2eTargets(["test/e2e/mock-chatwork.ts"], "").map((t) => t.script)).toEqual(["test/e2e/chatwork.sh claude"])
  expect(e2eTargets(["test/e2e/notices.sh"], "")).toEqual([{ script: "test/e2e/notices.sh claude", reasons: ["test/e2e/notices.sh"] }])
  expect(e2eTargets(["test/e2e/mock-line.ts"], "").map((t) => t.script)).toEqual([...CORE, "test/e2e/notices.sh claude"])
  expect(e2eTargets(["test/e2e/lib.sh"], "").map((t) => t.script)).toEqual([...CORE, "test/e2e/chatwork.sh claude", "test/e2e/notices.sh claude"])
  expect(e2eTargets(["src/shutdown.ts"], "")).toEqual([])
})

test("ハーネスのアダプターと ACP・MCP の SDK のバージョンを変えたら、e2e の中核を挙げる。ほかの依存では挙げない", () => {
  const diff = (line: string) => `diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n${line}\n`
  for (const [line, name] of [
    ['-    "@agentclientprotocol/claude-agent-acp": "0.101.0",', "@agentclientprotocol"],
    ['+    "@modelcontextprotocol/sdk": "1.33.0",', "@modelcontextprotocol"],
    ['+    "@anthropic-ai/claude-agent-sdk": ["@anthropic-ai/claude-agent-sdk@0.3.0", ...],', "@anthropic-ai/claude"],
  ] as const) {
    expect(e2eTargets(["package.json", "bun.lock"], diff(line))).toEqual(CORE.map((script) => ({ script, reasons: [`依存（${name}）`] })))
  }
  expect(e2eTargets(["package.json"], diff('+    "discord.js": "14.29.0",'))).toEqual([])
  // 複数の依存は、重ねずに「、」でつなぐ
  const two = diff('-    "@agentclientprotocol/sdk": "2.4.0",\n+    "@agentclientprotocol/sdk": "2.5.0",\n+    "@modelcontextprotocol/sdk": "1.33.0",')
  expect(e2eTargets(["package.json"], two)[0]!.reasons).toEqual(["依存（@agentclientprotocol、@modelcontextprotocol）"])
  // 差分の見出し（--- a/ や +++ b/）と、変えていない行は数えない
  expect(e2eTargets(["package.json"], ' "@agentclientprotocol/claude-agent-acp": "0.101.0",\n--- a/@agentclientprotocol\n+++ b/@agentclientprotocol\n')).toEqual([])
})

test("e2e の判定は、コマンドとして起動すると、main との差分から結果を表示する", () => {
  // 結果は、このブランチの差分しだいなので、表示の形だけを確かめる
  const r = Bun.spawnSync([...BUN_ISOLATED, "scripts/e2e-targets.ts", "HEAD"], { cwd: join(import.meta.dir, "..") })
  expect(r.exitCode).toBe(0)
  expect(r.stdout.toString()).toMatch(/^e2e: /)
})

// lib.sh を、記録のファイルを与えて bash で動かす
function lib(script: string, ...args: string[]) {
  const log = join(dir, "sent.jsonl")
  writeFileSync(log, "a\nb 赤\n")
  const r = Bun.spawnSync(["bash", "-c", `set -uo pipefail; LOG=${JSON.stringify(log)}; . test/e2e/lib.sh; ${script}`, "_", ...args], { cwd: join(import.meta.dir, "..") })
  return { code: r.exitCode, out: r.stdout.toString() }
}

test("e2e は、どれかの手順が失敗したら、続く手順も走らせてから、0 以外で終わり、失敗した手順を挙げる", () => {
  const failed = lib('check "A" false; check "B" sent_after 1 赤; check_model "C" sent_after 2 赤; echo "after"; finish')
  expect(failed.code).toBe(1)
  expect(failed.out).toContain("NG: A\nok: B\nNG: C（モデルの能力に頼る手順。中継の退行とは限らない）\nafter\n")
  expect(failed.out).toContain("失敗した手順（2 件）\n- A\n- C（")
  expect(lib('check "A" true; finish').code).toBe(0)
})

test("e2e の記録の検索は、一致した行の後に記録が長く続いても、一致したとみなす（pipefail で SIGPIPE を失敗にしない）", () => {
  const big = join(dir, "big.jsonl")
  writeFileSync(big, `a\n赤\n${"x\n".repeat(200_000)}`)
  expect(lib(`LOG=${JSON.stringify(big)}; sent_after 1 赤`).code).toBe(0)
  expect(lib(`LOG=${JSON.stringify(big)}; sent_after 2 赤`).code).toBe(1)
})

test("e2e の引数は、ハーネス名（既定は claude）と --full", () => {
  expect(lib('echo "$H $FULL"').out).toBe("claude 0\n")
  expect(lib('echo "$H $FULL"', "opencode", "--full").out).toBe("opencode 1\n")
})
