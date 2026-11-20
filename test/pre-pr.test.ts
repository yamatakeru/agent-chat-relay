import { describe, expect, test } from "bun:test"
import { draft, type Mutation, type Results, testCounts } from "../scripts/pre-pr.ts"

const op = { operator: "negate-condition", change: { from: "<condition>", to: "true" } }
const base: Results = { base: "main", tests: { pass: 144, fail: 0 }, check: true, mutation: undefined, e2e: [] }

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

<!-- bun run pre-pr が、main との差分で書いた下書き。数と区分は実際の値なので、書き換えない。（）を埋める -->
- \`bun test\`：144 件が通った。失敗 0 件
- \`bun run check\`：通った
- \`bun run mutation\`：結果を読めなかった
- e2e：挙げられなかった（ハーネスとの結合に関わる変更がない。ADR 0023）
- simplify：（最後の変更のあとにかけたか。何を直したか）
- レビュー：（最後の変更のあとにかけたか。指摘の数と対応）

## 確認できなかったこと

- **（項目）**：手段：（）。費用：（時間、実費）。確かめなかった理由：（）
`)
  })

  test("テストと検査の結果を書き、読めなかったもの、失敗したものはそう書く", () => {
    const ok = draft(base)
    expect(ok).toContain("- `bun test`：144 件が通った。失敗 0 件")
    expect(ok).toContain("- `bun run check`：通った")
    expect(ok).toContain("- `bun run mutation`：結果を読めなかった")
    expect(ok).toContain("main との差分")
    const ng = draft({ ...base, base: "a1b2", tests: undefined, check: false })
    expect(ng).toContain("- `bun test`：結果を読めなかった")
    expect(ng).toContain("- `bun run check`：失敗した")
    expect(ng).toContain("a1b2 との差分")
  })

  test("変異は 0 個でない状態だけを数え、捕まえていないものを、生き残りは 1 つずつ、ほかはファイルと区分ごとに挙げる", () => {
    const mutation: Mutation = {
      summary: { counts: { total: 8, killed: 1, timeout: 1, survived: 1, no_coverage: 3, pruned: 1, runtime_error: 1, flaky: 0 } },
      mutants: [
        { file: "src/a.ts", line: 1, status: "killed", ...op },
        { file: "src/a.ts", line: 2, status: "timeout", ...op },
        { file: "src/a.ts", line: 9, status: "survived", ...op },
        { file: "src/b.ts", line: 3, status: "no_coverage", test_reach: { reach: "none" }, ...op },
        { file: "src/b.ts", line: 4, status: "no_coverage", test_reach: { reach: "none" }, ...op },
        { file: "src/c.ts", line: 5, status: "no_coverage", test_reach: { reach: "none-file" }, ...op },
        { file: "src/d.ts", line: 6, status: "pruned", prune_reason: "dead-code", ...op },
        { file: "src/e.ts", line: 7, status: "runtime_error", ...op },
      ],
    }
    const d = draft({ ...base, mutation })
    expect(d).toContain("- `bun run mutation`：変異 8 個のうち、捕まえた 1 個、時間切れ（捕まえたものとして数える） 1 個、生き残り 1 個、テストが届かない 3 個、pruned 1 個、runtime_error 1 個\n")
    expect(d).toContain("  - 捕まえていない変異。テストで捕まえるか、捕まえない理由を書く：\n")
    expect(d).toContain("    - `src/a.ts:9`（生き残り。negate-condition `<condition>` → `true`） 1 個：（理由）")
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
        { file: "src/a.ts", line: 1, status: "killed", ...op },
        { file: "src/a.ts", line: 2, status: "timeout", ...op },
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
    expect(d).toContain("## 確認できなかったこと\n\n- **（項目）**：手段：（）。費用：（時間、実費）。確かめなかった理由：（）")
  })
})
