import { describe, expect, mock, spyOn, test } from "bun:test"
import { approvePiToolCall, describePiToolCall } from "../src/harness/pi/tool-approval.ts"

type Confirm = Parameters<typeof approvePiToolCall>[1]["ui"]["confirm"]

const read = { toolName: "read", input: { path: "fixture.txt", offset: 2, limit: 3 } }
const write = { toolName: "write", input: { path: "fixture.txt", content: "fixture replacement body" } }
const edit = { toolName: "edit", input: { path: "fixture.txt", edits: [{ oldText: "fixture old body", newText: "fixture new body" }] } }
const bash = { toolName: "bash", input: { command: "printf fixture", timeout: 1 } }
const blocked = { block: true, reason: "実行が許可されませんでした" } as const

function context(confirm: Confirm, signal = new AbortController().signal) {
  return { hasUI: true, signal, ui: { confirm } }
}

describe("describePiToolCall", () => {
  test("組み込みツールの操作と対象だけを表示する", () => {
    expect(describePiToolCall(read)).toEqual({ title: "read：ファイルの読み取り", message: '対象パス: "fixture.txt"' })
    expect(describePiToolCall(write)).toEqual({ title: "write：ファイルの作成・上書き", message: '対象パス: "fixture.txt"' })
    expect(describePiToolCall(edit)).toEqual({ title: "edit：ファイルの編集", message: '対象パス: "fixture.txt"' })
    expect(describePiToolCall(bash)).toEqual({ title: "bash：シェルの実行", message: 'コマンド: "printf fixture"' })
  })

  test("未知のツールでは対象を推測せず、入力も転送しない", () => {
    expect(describePiToolCall({ toolName: "fixture_tool", input: { path: "fixture.txt", content: "fixture body" } })).toEqual({
      title: "その他のツールの実行",
      message: 'ツール: "fixture_tool"（対象を確認できません）',
    })
  })

  test("欠損や型違いを表示上も区別する", () => {
    expect(describePiToolCall({ toolName: "read", input: null }).message).toBe("対象パスを確認できません")
    expect(describePiToolCall({ toolName: "edit", input: { path: 42 } }).message).toBe("対象パスを確認できません")
    expect(describePiToolCall({ toolName: "bash", input: { command: " " } }).message).toBe("コマンドを確認できません")
  })

  test("ファイル名の改行と表示方向の制御文字をエスケープする", () => {
    const message = describePiToolCall({ toolName: "read", input: { path: "line\nbreak\u202E.txt" } }).message
    expect(message).toBe('対象パス: "line\\nbreak\\u{202e}.txt"')
  })
})

describe("approvePiToolCall", () => {
  test("編集・シェル・未知・対象不明・範囲の内外いずれの読み取りも承認なしでは通さない", async () => {
    const calls = [
      read, write, edit, bash,
      { toolName: "read", input: { path: "../neighbor-fixture.txt" } },
      { toolName: "read", input: {} },
      { toolName: "fixture_tool", input: {} },
      { toolName: "mcp__chat__reply", input: {} }, // この関数は名前による承認免除を持たない。
    ]
    const confirm = mock<Confirm>(async () => false)
    for (const call of calls) {
      const before = confirm.mock.calls.length
      expect(await approvePiToolCall(call, context(confirm))).toEqual(blocked)
      expect(confirm).toHaveBeenCalledTimes(before + 1)
      const { title, message } = describePiToolCall(call)
      expect(confirm).toHaveBeenLastCalledWith(title, message, { timeout: 30 * 60 * 1000, signal: expect.any(AbortSignal) })
    }
  })

  test("今回だけ許可し、同じ操作でも次回は聞き直す", async () => {
    const confirm = mock<Confirm>(async () => false).mockResolvedValueOnce(true)
    const ctx = context(confirm)
    expect(await approvePiToolCall(write, ctx)).toBeUndefined()
    expect(await approvePiToolCall(write, ctx)).toEqual(blocked)
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  test("UI やターンの中断経路がない、またはすでに中断していれば確認を始めない", async () => {
    const confirm = mock<Confirm>(async () => true)
    const ctx = context(confirm)
    expect(await approvePiToolCall(read, { ...ctx, hasUI: false })).toEqual(blocked)
    expect(await approvePiToolCall(read, { ...ctx, signal: undefined })).toEqual(blocked)
    expect(await approvePiToolCall(read, { ...ctx, signal: AbortSignal.abort() })).toEqual(blocked)
    expect(await approvePiToolCall(read, ctx, { sessionSignal: AbortSignal.abort() })).toEqual(blocked)
    for (const timeoutMs of [0, -1, NaN, 1.5, 30 * 60 * 1000 + 1]) {
      expect(await approvePiToolCall(read, ctx, { timeoutMs })).toEqual(blocked)
    }
    expect(confirm).not.toHaveBeenCalled()
  })

  test("確認が失敗するか true 以外を返す場合は拒否する", async () => {
    const rejected: Confirm = async () => { throw new Error("fixture UI error") }
    const thrown: Confirm = () => { throw new Error("fixture synchronous UI error") }
    const invalid: Confirm = async () => "yes" as unknown as boolean
    for (const confirm of [rejected, thrown, invalid]) {
      expect(await approvePiToolCall(write, context(confirm))).toEqual(blocked)
    }
  })

  for (const source of ["turn", "session"] as const) {
    test(`${source} の中断で待機を解き、その後の許可は採用しない`, async () => {
      const turn = new AbortController()
      const session = new AbortController()
      const reply = Promise.withResolvers<boolean>()
      const confirm = mock<Confirm>(() => reply.promise)
      const approval = approvePiToolCall(bash, context(confirm, turn.signal), { sessionSignal: session.signal })
      const signal = confirm.mock.calls[0]![2].signal
      expect(signal.aborted).toBe(false)
      const controller = source === "turn" ? turn : session
      controller.abort()
      expect(await approval).toEqual(blocked)
      expect(signal.aborted).toBe(true)
      reply.resolve(true)
      expect(await approval).toEqual(blocked)
    })
  }

  test("許可の返事を受け取った同じ実行順で中断した場合も拒否する", async () => {
    const turn = new AbortController()
    const reply = Promise.withResolvers<boolean>()
    const approval = approvePiToolCall(read, context(() => reply.promise, turn.signal))
    reply.resolve(true)
    turn.abort()
    expect(await approval).toEqual(blocked)
  })

  test("期限切れで待機を解き、その後の許可は採用しない", async () => {
    const reply = Promise.withResolvers<boolean>()
    const confirm = mock<Confirm>(() => reply.promise)
    const approval = approvePiToolCall(bash, context(confirm), { timeoutMs: 20 })
    expect(await approval).toEqual(blocked)
    expect(confirm.mock.calls[0]![2].signal.aborted).toBe(true)
    reply.resolve(true)
    expect(await approval).toEqual(blocked)
  })

  test("期限タイマーがまだ実行されていなくても期限後の返事を拒否する", async () => {
    const now = spyOn(performance, "now").mockReturnValue(0)
    try {
      const confirm = mock<Confirm>(async () => {
        now.mockReturnValue(10)
        return true
      })
      expect(await approvePiToolCall(read, context(confirm), { timeoutMs: 10 })).toEqual(blocked)
      expect(confirm.mock.calls[0]![2].signal.aborted).toBe(false)
    } finally {
      now.mockRestore()
    }
  })
})
