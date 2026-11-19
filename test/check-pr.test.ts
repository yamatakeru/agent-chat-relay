// scripts/check-pr.ts の検査が、過去の実際のミスで失敗すること。本文は、GitHub の編集の履歴から取り出したものの抜粋
import { expect, test } from "bun:test"
import { linkErrors, refsOf } from "../scripts/check-pr.ts"

// PR #74 の最初の本文（2026-11-19 04:06）。冒頭で #52 に触れているが、Refs がなかった
const PR74_FIRST = "#52 のうち、`RELAY_WORKSPACE` の扱いに関する 3 項目を片付けます。\n\n## 変更\n\n- ...\n\n## 確認できなかったこと\n\n- ..."
// そのときの統括 issue #71 の本文（2026-11-19 03:45 の版）の抜粋。#52 はあるが #74 はない。#52 は 03:41 から #71 の sub-issue
const T71_AT_74 = "- [ ] #50 差し込みの結果を待つ間にターンが終わっても、次の発言を差し込もうとする\n- [ ] #52 作業ディレクトリと起動まわりの、残りの候補"
// PR #54 の最初の本文（2026-11-19 03:00）の末尾。#53 は、どの統括 issue の sub-issue でもなかった
const PR54_FIRST_TAIL = "- 中継の全体（偽の ACP エージェント）で、…動かして確かめていません。SDK のソースを読んだだけです。\n\nRefs #53"
// そのときの統括 issue #7 の本文（2026-11-17 17:19 の版。次の編集は #54 を作ったあとの 03:11）の抜粋。#53 も #54 もない
const T7_AT_54 = "- [x] 後半（PR #44）：`bin`（Bun に cwd のファイルを読ませないシェルスクリプト）…\n- [ ] 承認依頼の送り先：承認者の DM（今）か、依頼のあったルームか。使いながら判断する。#29 で、…"

test("Refs・Closes などに続く番号だけを拾う", () => {
  expect(refsOf(PR74_FIRST)).toEqual([])
  expect(refsOf(PR54_FIRST_TAIL)).toEqual([53])
  expect(refsOf("Closes #12、#13\nfix: 何か（#14）\nresolves: #15")).toEqual([12, 13, 15])
  expect(refsOf("Refs #53, other/project#71")).toEqual([53])
})

test("PR #74 の最初の本文は、Refs がなく統括 issue にも載っていないので落ちる。Refs #52 を足すと通る", () => {
  expect(linkErrors(74, [], [T71_AT_74])[0]).toContain("PR の本文に「Refs #<issue>」を書き")
  expect(linkErrors(74, [{ number: 52, tracking: false, parentTracking: true }], [T71_AT_74])).toEqual([])
})

test("PR #54 は、指した #53 が統括 issue の sub-issue でなく、PR も載っていないので落ちる", () => {
  expect(linkErrors(54, [{ number: 53, tracking: false, parentTracking: false }], [T7_AT_54])[0]).toContain("指した issue（#53）を、統括 issue の sub-issue にする")
})

test("issue のない PR は、統括 issue の本文に PR の番号があれば通る。統括 issue そのものを指しても通る", () => {
  expect(linkErrors(56, [], ["- [x] AGENTS.md の規則の表に、…2 行を足す（PR #56）"])).toEqual([])
  expect(linkErrors(56, [], ["- [x] …（PR #560）"])).toHaveLength(1)
  expect(linkErrors(74, [], ["- [x] other/project#74"])).toHaveLength(1)
  expect(linkErrors(72, [{ number: 71, tracking: true, parentTracking: false }], [])).toEqual([])
})
