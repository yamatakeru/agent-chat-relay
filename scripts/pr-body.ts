// PR 本文の「確認できなかったこと」を検査する（ADR 0025）。判定は scripts/pr-draft.ts の unverifiedErrors。
// PR を作る前に手元で、本文のファイルに走らせる。CI（.github/workflows/pr-body.yml）は、GitHub のイベントの JSON に走らせる
//
//   bun run pr-body <本文のファイル>
//   bun run pr-body --event <GitHub のイベントの JSON>

import { readFileSync } from "node:fs"
import { unverifiedErrors } from "./pr-draft.ts"

const event = process.argv[2] === "--event"
const file = process.argv[event ? 3 : 2]
if (!file) {
  console.error("使い方: bun run pr-body <本文のファイル> | bun run pr-body --event <GitHub のイベントの JSON>")
  process.exit(2)
}
const text = readFileSync(file, "utf8")
// CI では、本文を run: に式で埋め込まず、イベントの JSON から読む（本文に何が書かれていても、シェルに渡らない）
const body: string = event ? (JSON.parse(text).pull_request?.body ?? "") : text
const errors = unverifiedErrors(body)
for (const e of errors) console.error(e)
if (errors.length) process.exit(1)
