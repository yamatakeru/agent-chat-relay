// serve の引数：[harness] [--session-id <id>]。不正な引数は、接続部やハーネスを起動する前に拒否する。

export const HARNESSES = ["claude", "opencode"] as const
export type HarnessName = (typeof HARNESSES)[number]

export type ServeArgs = { harness: HarnessName; sessionId?: string }

const MAX_SESSION_ID = 256

export function parseServeArgs(args: string[], defaultHarness = "claude"): ServeArgs {
  let harness: string | undefined
  let sessionId: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--session-id" || arg.startsWith("--session-id=")) {
      if (sessionId !== undefined) throw new Error("--session-id が 2 回指定されています")
      const value = arg === "--session-id" ? args[++i] : arg.slice("--session-id=".length)
      if (value === undefined || value.startsWith("-")) throw new Error("--session-id の値がありません")
      sessionId = checkSessionId(value)
    } else if (arg.startsWith("-")) {
      throw new Error(`知らないオプションです: ${arg}`)
    } else if (harness !== undefined) {
      throw new Error(`ハーネスは 1 つだけ指定できます: ${harness} と ${arg}`)
    } else {
      harness = arg
    }
  }
  harness ??= defaultHarness
  if (!(HARNESSES as readonly string[]).includes(harness)) throw new Error(`知らないハーネスです: ${harness}（${HARNESSES.join(" か ")}）`)
  return { harness: harness as HarnessName, sessionId }
}

/** セッション ID の形式はハーネスごとに違う（Claude は UUID）ので、明らかにおかしいものだけを拒否する */
function checkSessionId(id: string): string {
  if (id === "") throw new Error("--session-id の値が空です")
  if (id.length > MAX_SESSION_ID) throw new Error(`--session-id の値が長すぎます（${MAX_SESSION_ID} 文字まで）`)
  if (/[\s\p{Cc}]/u.test(id)) throw new Error("--session-id の値に空白か制御文字が含まれています")
  return id
}
