import assert from "node:assert/strict"
import { test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { managedRead } from "../src/vendor/pi/managed-read.ts"

test.skipIf(process.platform !== "darwin")("pi の作業ディレクトリ内の読み取りは、パスが後から変わっても確認済みの内容だけを返す", async () => {
  const local = join(import.meta.dir, "..", ".local")
  mkdirSync(local, { recursive: true })
  const root = realpathSync(mkdtempSync(join(local, "test-pi-read-")))
  const cwd = join(root, "workspace")
  const previous = process.cwd()
  try {
    mkdirSync(cwd)
    process.chdir(cwd)
    const outside = join(root, "outside.txt")
    writeFileSync(outside, "outside-fixture")
    writeFileSync("sample.txt", "inside-fixture")
    const signal = new AbortController().signal
    const read = managedRead(cwd, root, signal)
    const ctx = { cwd, signal, hasUI: true, ui: { async confirm() { assert.fail("実行承認は不要") } } }
    // このテストは実行時に使うコンテキストの部分だけを渡す。
    const toolCtx = ctx as unknown as Parameters<typeof read.execute>[4]
    // 同じ fd からの取得は同期で終わる。Pi の結果整形を待つ間に同名のリンクへ差し替える。
    const result = read.execute("read-1", { path: "sample.txt" }, signal, undefined, toolCtx)
    renameSync("sample.txt", "moved.txt")
    symlinkSync(outside, "sample.txt")
    assert.deepEqual((await result).content, [{ type: "text", text: "inside-fixture" }])
  } finally {
    process.chdir(previous)
    rmSync(root, { recursive: true, force: true })
  }
})
