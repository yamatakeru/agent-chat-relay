import { describe, expect, test } from "bun:test"
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { draft, draftHeadErrors, type Mutation, parseMutation, type Results, testCounts, unverifiedErrors } from "../scripts/pr-draft.ts"
import { BUN_ISOLATED } from "../src/harness/config.ts"
import { tempDir } from "./tmp.ts"

const op = { operator: "negate-condition", change: { from: "<condition>", to: "true" } }
const base: Results = { base: "main", head: "abc1234", tests: { pass: 144, fail: 0 }, check: true, mutation: undefined, e2e: [] }

describe("PR を出す前の下書き（ADR 0025）", () => {
  test("bun test の出力から、通った数と失敗した数を読む。どちらかがなければ読めないとする", () => {
    expect(testCounts(" 144 pass\n 2 fail\n Ran 146 tests")).toEqual({ pass: 144, fail: 2 })
    expect(testCounts(" 144 pass\n")).toBeUndefined()
    expect(testCounts("error: 3 passed")).toBeUndefined()
    // テストの名前の中の「3 pass」や、「3 passes」は読まない。数は行の頭（空白のあと）から読む
    expect(testCounts("(pass) x 3 pass\n(fail) y 4 fail\n 5 pass\n 6 fail")).toEqual({ pass: 5, fail: 6 })
    expect(testCounts(" 5 passes\n 6 fail")).toBeUndefined()
    expect(testCounts(" 5 pass\n 6 fails")).toBeUndefined()
    expect(testCounts("15 pass\n16 fail")).toEqual({ pass: 15, fail: 16 })
  })

  test("下書きの全文", () => {
    expect(draft(base)).toBe(`## 確認

<!-- bun run pre-pr が、コミット abc1234 で、main との差分から書いた下書き。数と区分は実際の値なので、書き換えない。（）を埋める -->
- \`bun test\`：144 件が通った。失敗 0 件
- \`bun run check\`：通った
- \`bun run mutation\`：結果を読めなかった
- e2e：挙げられなかった（ハーネスとの結合に関わる変更がない。ADR 0023）
- simplify：（最後の変更のあとにかけたか。何を直したか）
- レビュー：（最後の変更のあとにかけたか。指摘の数と対応）

## 確認できなかったこと

- **（項目）**：区分：（実サービス／手段なし／承認 名前）。手段：（）。費用：（時間、実費）。確かめなかった理由：（）
`)
  })

  test("テストと検査の結果を書き、読めなかったもの、失敗したものはそう書く", () => {
    const ok = draft(base)
    expect(ok).toContain("- `bun test`：144 件が通った。失敗 0 件")
    expect(ok).toContain("- `bun run check`：通った")
    expect(ok).toContain("- `bun run mutation`：結果を読めなかった")
    expect(ok).toContain("コミット abc1234 で、main との差分")
    const ng = draft({ ...base, base: "a1b2", tests: undefined, check: false })
    expect(ng).toContain("- `bun test`：結果を読めなかった")
    expect(ng).toContain("- `bun run check`：失敗した")
    expect(ng).toContain("a1b2 との差分")
  })

  test("ミューテーションの結果は、標準出力の JSON から読む。fallow のエラーや、JSON でないものは読めないとする", () => {
    const ok = { summary: { counts: { total: 1, killed: 1 } }, mutants: [] }
    expect(parseMutation(JSON.stringify(ok))).toEqual(ok)
    expect(parseMutation('{"error":true,"message":"the git worktree has 1 uncommitted path","exit_code":2}')).toBeUndefined()
    expect(parseMutation('{"summary":{"counts":{}}}')).toBeUndefined()
    expect(parseMutation('{"summary":{},"mutants":[]}')).toBeUndefined()
    expect(parseMutation(`e2e: 次を走らせ\n${JSON.stringify(ok)}`)).toBeUndefined()
    expect(parseMutation("")).toBeUndefined()
  })

  test("変異は 0 個でない状態だけを数え、捕まえていないものを、生き残りは 1 つずつ、ほかはファイルと区分ごとに挙げる", () => {
    const mutation: Mutation = {
      summary: { counts: { total: 9, killed: 1, timeout: 1, survived: 2, no_coverage: 3, pruned: 1, runtime_error: 1, flaky: 0 } },
      mutants: [
        { file: "src/a.ts", line: 1, column: 1, status: "killed", ...op },
        { file: "src/a.ts", line: 2, column: 1, status: "timeout", ...op },
        { file: "src/a.ts", line: 9, column: 3, status: "survived", ...op },
        // 同じ行の、同じ種類の変異でも、別々に挙げる
        { file: "src/a.ts", line: 9, column: 12, status: "survived", ...op },
        { file: "src/b.ts", line: 3, column: 1, status: "no_coverage", test_reach: { reach: "none" }, ...op },
        { file: "src/b.ts", line: 4, column: 1, status: "no_coverage", test_reach: { reach: "none" }, ...op },
        { file: "src/c.ts", line: 5, column: 1, status: "no_coverage", test_reach: { reach: "none-file" }, ...op },
        { file: "src/d.ts", line: 6, column: 1, status: "pruned", prune_reason: "dead-code", ...op },
        { file: "src/e.ts", line: 7, column: 1, status: "runtime_error", ...op },
      ],
    }
    const d = draft({ ...base, mutation })
    expect(d).toContain("- `bun run mutation`：変異 9 個のうち、捕まえた 1 個、時間切れ（捕まえたものとして数える） 1 個、生き残り 2 個、テストが届かない 3 個、pruned 1 個、runtime_error 1 個\n")
    expect(d).toContain("  - 捕まえていない変異。テストで捕まえるか、捕まえない理由を書く：\n")
    expect(d).toContain("    - `src/a.ts:9:3`（生き残り。negate-condition `<condition>` → `true`） 1 個：（理由）")
    expect(d).toContain("    - `src/a.ts:9:12`（生き残り。negate-condition `<condition>` → `true`） 1 個：（理由）")
    expect(d).toContain("    - `src/b.ts`（テストが届かない。区分 none） 2 個：（理由）")
    expect(d).toContain("    - `src/c.ts`（テストが届かない。区分 none-file） 1 個：（理由）")
    expect(d).toContain("    - `src/d.ts`（pruned。理由 dead-code） 1 個：（理由）")
    expect(d).toContain("    - `src/e.ts`（runtime_error。区分なし） 1 個：（理由）")
    // 捕まえたもの（killed と timeout）は挙げない
    expect(d).not.toContain("src/a.ts`（")
  })

  test("すべて捕まえたら、捕まえていない変異の欄を作らない", () => {
    const mutation: Mutation = {
      summary: { counts: { total: 2, killed: 1, timeout: 1 } },
      mutants: [
        { file: "src/a.ts", line: 1, column: 1, status: "killed", ...op },
        { file: "src/a.ts", line: 2, column: 1, status: "timeout", ...op },
      ],
    }
    const d = draft({ ...base, mutation })
    expect(d).toContain("- `bun run mutation`：変異 2 個のうち、捕まえた 1 個、時間切れ（捕まえたものとして数える） 1 個\n")
    expect(d).not.toContain("捕まえていない変異")
    const none = draft({ ...base, mutation: { summary: { counts: { total: 0, killed: 0 } }, mutants: [] } })
    expect(none).toContain("- `bun run mutation`：変異 0 個（変えた行に、変異させる箇所がない）\n")
  })

  test("挙げられた e2e ごとに結果の欄を作り、なければそう書く。simplify、レビュー、確認できなかったことの欄を作る", () => {
    const d = draft({ ...base, e2e: [{ script: "test/e2e/line.sh claude", reasons: ["src/main.ts"] }] })
    expect(d).toContain("- e2e（ADR 0023）：\n  - `test/e2e/line.sh claude`：（結果。モデル）")
    expect(draft(base)).toContain("- e2e：挙げられなかった")
    expect(d).toContain("- simplify：（最後の変更のあとにかけたか")
    expect(d).toContain("- レビュー：（最後の変更のあとにかけたか")
    expect(d).toContain("## 確認できなかったこと\n\n- **（項目）**：区分：（実サービス／手段なし／承認 名前）。手段：（）。費用：（時間、実費）。確かめなかった理由：（）")
  })

  test("「確認できなかったこと」の項目に区分がなければ、項目ごとに挙げる。手元で確かめられるものを省いた #106 の本文で失敗する", () => {
    // #106 の最初の本文（2 つ目の項目は、実際の Claude Code（Haiku）とモックの LINE で、5 分ほどで確かめられた）
    const pr106 = [
      "## 確認",
      "",
      "- `bun test`：204 件が通った。失敗 0 件",
      "",
      "## 確認できなかったこと",
      "",
      "- **実サービスの発言の形**：LINE の `mentionee.type` は、OpenAPI 定義に合わせたモックで確かめた。",
      "  - 手段：試験用のルームで、他人宛ての発言を 1 つずつ送る。",
      "  - 費用：サービスごとに 10〜15 分。",
      "- **新しい案内で、エージェントが `mentioned` のない発言に黙るか**：",
      "  - 手段：実際の Claude Code とモックの LINE で、「すべて」のルームに雑談を流す。",
      "  - 費用：5 分ほど。契約の利用枠を少し使う。",
      "  - 確かめなかった理由：案内は振る舞いを促すだけで、安全境界でも、この PR の節約の仕組みでもないため。",
      "",
    ].join("\n")
    const errors = unverifiedErrors(pr106)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toContain("「**実サービスの発言の形**：LINE の `mentionee.type` は」に、区分")
    expect(errors[1]).toContain("「**新しい案内で、エージェントが `mentioned` のない発言に黙るか**」に、区分")
    expect(errors[1]).toContain("区分（区分：実サービス、区分：手段なし、区分：承認 名前）がない")
    expect(errors[1]).toContain("確かめて「確認」に移す")
    expect(errors[1]).toContain("「区分：承認 名前」と書く（skill pre-pr）")
    // 実サービスの項目に区分を付けても、手元で確かめられる項目に当たる区分はない
    const marked = pr106.replace("**実サービスの発言の形**：", "**実サービスの発言の形**：区分：実サービス。")
    expect(unverifiedErrors(marked)).toEqual([errors[1]!])
    // 区分は、字下げした行に書いてもよい。空行を挟んでも、同じ項目として読む
    expect(unverifiedErrors(marked.replace("  - 費用：5 分ほど。", "\n  - 区分：手段なし\n  - 費用：5 分ほど。"))).toEqual([])
  })

  test("区分は、実サービス、手段なし、承認と名前だけを認める。下書きの（）のままのものは認めない", () => {
    const section = (item: string) => `## 確認できなかったこと\n\n- **a**：${item}\n`
    for (const ok of ["区分：実サービス。", "区分：手段なし", "区分：承認 yamatakeru。"]) expect(unverifiedErrors(section(ok))).toEqual([])
    for (const ng of ["区分：承認", "区分：承認 。", "区分：手元で 5 分", "区分：（実サービス／手段なし／承認 名前）", "区分: 実サービス"]) expect(unverifiedErrors(section(ng))).toHaveLength(1)
    expect(unverifiedErrors(draft(base))).toHaveLength(1)
    // 箇条書きの記号によらず、項目として読む
    expect(unverifiedErrors("## 確認できなかったこと\n\n* a\n+ b\n1. c\n2) d\n9. 区分：手段なし\n10. e\n")).toHaveLength(5)
  })

  test("節がない本文、「なし」、節の後ろの別の節と地の文は、検査しない", () => {
    expect(unverifiedErrors("## 変更\n\n- x\n")).toEqual([])
    expect(unverifiedErrors("## 確認できなかったこと\n\nなし。\n")).toEqual([])
    expect(unverifiedErrors("## 確認できなかったこと\r\n\r\n- なし。\r\n")).toEqual([])
    expect(unverifiedErrors("## 確認できなかったこと\n\n- なし\n\n## 残したもの\n\n- x\n")).toEqual([])
    // 節の中の小見出しの下の項目も、検査する
    expect(unverifiedErrors("## 確認できなかったこと\n\n- なし\n\n### 補足\n\n- x\n")).toHaveLength(1)
    // 節の外の箇条書きは見ない。見出しの行は、名前が同じものだけを節とする
    expect(unverifiedErrors("- x\n- y\n")).toEqual([])
    expect(unverifiedErrors("## 確認できなかったことの補足\n\n- x\n")).toEqual([])
    expect(unverifiedErrors("## 確認できなかったこと  \n\n- x\n")).toHaveLength(1)
    // 「なし」は項目の全体がそれのときだけ
    expect(unverifiedErrors("## 確認できなかったこと\n\n- なし。ただし x は試していない\n")).toHaveLength(1)
    expect(unverifiedErrors("## 確認できなかったこと\n\n- x の確認はなし\n")).toHaveLength(1)
    // 改行が CRLF の本文（GitHub の画面で直したもの）も読む。挙げるのは項目の 1 行目だけ
    expect(unverifiedErrors("## 確認できなかったこと\r\n\r\n- **a**：x\r\n  - y\r\n")).toEqual([expect.stringContaining("の「**a**：x」に、区分")])
    // 地の文（訂正、Closes）と、その後ろの字下げした行は、項目に入れない
    expect(unverifiedErrors("## 確認できなかったこと\n\n- **a**：区分：手段なし。\n\n（訂正 2026-11-20）x\n  - y\n\nCloses #90\n")).toEqual([])
    expect(unverifiedErrors("## 確認できなかったこと\n\n- **a**：x\n\n（訂正）y\n  - 区分：手段なし\n")).toHaveLength(1)
    expect(unverifiedErrors("## 確認できなかったこと\n\n- **a**：x\n  - z\n（訂正）y\n  - 区分：手段なし\n")).toHaveLength(1)
  })

  test("#109 の古い下書きを拒否し、先頭で作った下書きと下書きのない本文は通す", () => {
    const head = "03e08898995dc151bc6bcd381543271f2d334c55"
    const stale = "<!-- bun run pre-pr が、コミット 4604684e で、main との差分から書いた下書き -->"
    const staleError = draftHeadErrors(stale, head)
    expect(staleError).toEqual([expect.stringContaining("最後のコミットで bun run pre-pr を走らせ直し")])
    expect(staleError[0]).toContain(`（4604684e）が、先頭のコミット（${head}）`)
    for (const spaces of [" ", "  ", "   "]) expect(draftHeadErrors(`${spaces}${stale}\r\n`, head)).toEqual(staleError)
    const fresh = draft({ ...base, head })
    expect(draftHeadErrors(fresh, head)).toEqual([])
    expect(draftHeadErrors(fresh, "")).toEqual([expect.stringContaining("先頭のコミット（不明）")])
    expect(draftHeadErrors(`${fresh}\n${stale}`, head)).toEqual(staleError)
    expect(draftHeadErrors(fresh.replace(head, head.slice(0, 8)), head)).toEqual([])
    expect(draftHeadErrors(fresh.replace(head, `余分な文字 ${head}`), head)).toEqual([expect.stringContaining("下書きのコミット（不明）")])
    expect(draftHeadErrors(`## 変更\n\n- ${stale}\n`, head)).toEqual([])
  })

  test("bun run pr-body は、本文のファイルと、GitHub のイベントの JSON を検査し、違反があれば 1 で終わる", () => {
    const dir = tempDir("pr-body-")
    try {
      const run = (...args: string[]) => Bun.spawnSync([...BUN_ISOLATED, join(import.meta.dir, "../scripts/pr-body.ts"), ...args], { stdout: "pipe", stderr: "pipe" })
      const write = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name))
      const ng = "## 確認できなかったこと\n\n- **a**：x\n"
      const ok = "## 確認できなかったこと\n\n- **a**：区分：実サービス。x\n"
      const bad = run(write("ng.md", ng))
      expect(bad.exitCode).toBe(1)
      expect(bad.stderr.toString()).toContain("「**a**：x」に、区分")
      expect(run(write("ok.md", ok)).exitCode).toBe(0)
      expect(run("--event", write("ng.json", JSON.stringify({ pull_request: { body: ng } }))).exitCode).toBe(1)
      expect(run("--event", write("ok.json", JSON.stringify({ pull_request: { body: ok } }))).exitCode).toBe(0)
      // 本文のない PR（body が null）は通す
      expect(run("--event", write("null.json", JSON.stringify({ pull_request: { body: null } }))).exitCode).toBe(0)
      const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim()
      const other = "03e08898995dc151bc6bcd381543271f2d334c55"
      const confirmation = (sha: string) => `<!-- bun run pre-pr が、コミット ${sha} で、main との差分から書いた下書き -->`
      const local = (sha: string) => run(write("draft.md", confirmation(sha)))
      const ci = (sha: string) => run("--event", write("event.json", JSON.stringify({ pull_request: { body: confirmation(sha), head: { sha: other } } })))
      expect(local(head).exitCode).toBe(0)
      expect(local(other).exitCode).toBe(1)
      // CI ではチェックアウトしたコミットではなく、イベントの PR head と照合する
      expect(ci(other).exitCode).toBe(0)
      expect(ci(head).exitCode).toBe(1)
      expect(run().exitCode).toBe(2)
      expect(run("--event").exitCode).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
