// PR 本文の区分と pre-pr の下書きのコミットを検査する（ADR 0025）。
// 手元では本文のファイルと HEAD、CI では GitHub のイベントの本文と PR の head を使う
//
//   bun run pr-body <本文のファイル>
//   bun run pr-body --event <GitHub のイベントの JSON>

import { readFileSync } from "node:fs"
import { draftHeadErrors, unverifiedErrors } from "./pr-draft.ts"

const event = process.argv[2] === "--event"
const file = process.argv[event ? 3 : 2]
if (!file) {
  console.error("使い方: bun run pr-body <本文のファイル> | bun run pr-body --event <GitHub のイベントの JSON>")
  process.exit(2)
}
const text = readFileSync(file, "utf8")
// CI では、本文を run: に式で埋め込まず、イベントの JSON から読む（本文に何が書かれていても、シェルに渡らない）
const pr = event ? JSON.parse(text).pull_request : undefined
const body: string = event ? (pr?.body ?? "") : text
// pull_request ワークフローのチェックアウト先はマージ用のコミットなので、CI では HEAD を使わない
const head: string = event ? (pr?.head?.sha ?? "") : Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim()
/** 2 つのコミットの間で変わったファイル。コミットが見つからなければ undefined（CI は fetch-depth: 0 で履歴を取る） */
const changed = (from: string, to: string) => {
  const r = Bun.spawnSync(["git", "diff", "--name-only", from, to], { cwd: import.meta.dir, stderr: "pipe" })
  return r.exitCode === 0 ? r.stdout.toString().split("\n").filter(Boolean) : undefined
}
const errors = [...unverifiedErrors(body), ...draftHeadErrors(body, head, changed)]
for (const e of errors) console.error(e)
if (errors.length) process.exit(1)
