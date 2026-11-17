// serve の引数：[harness] [--session-id <id>] [--workspace <dir>] [--harness-settings default] [--harness-memory]。
// 不正な引数は、コネクターやハーネスを起動する前に拒否する。
// --workspace・--harness-settings・--harness-memory は、それぞれ RELAY_WORKSPACE・RELAY_HARNESS_SETTINGS・RELAY_HARNESS_MEMORY の別名で、環境変数より優先する（ADR 0017・0019）

export const HARNESSES = ["claude", "opencode"] as const
export type HarnessName = (typeof HARNESSES)[number]

/** env は、フラグで指定した環境変数の値。環境変数に重ねて使う */
export type ServeArgs = { harness: HarnessName; sessionId?: string; env?: Record<string, string> }

/** 値を取るフラグと、その別名の環境変数 */
const VALUE_FLAGS: Record<string, string> = { "--workspace": "RELAY_WORKSPACE", "--harness-settings": "RELAY_HARNESS_SETTINGS" }
/** 値を取らないフラグと、指定したときの環境変数の値 */
const SWITCH_FLAGS: Record<string, [string, string]> = { "--harness-memory": ["RELAY_HARNESS_MEMORY", "1"] }

const MAX_SESSION_ID = 256

export function parseServeArgs(args: string[], defaultHarness = "claude"): ServeArgs {
  let harness: string | undefined
  let sessionId: string | undefined
  const env: Record<string, string> = {}
  const seen = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const name = arg.split("=", 1)[0]!
    if (name.startsWith("--") && seen.has(name)) throw new Error(`${name} が 2 回指定されています`)
    seen.add(name)
    if (name === "--session-id" || name in VALUE_FLAGS) {
      const value = arg === name ? args[++i] : arg.slice(name.length + 1)
      if (value === undefined || value.startsWith("-")) throw new Error(`${name} の値がありません`)
      if (value === "") throw new Error(`${name} の値が空です`)
      if (name === "--session-id") sessionId = checkSessionId(value)
      else env[VALUE_FLAGS[name]!] = value
    } else if (arg in SWITCH_FLAGS) {
      const [key, value] = SWITCH_FLAGS[arg]!
      env[key] = value
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
  return { harness: harness as HarnessName, sessionId, ...(Object.keys(env).length > 0 ? { env } : {}) }
}

/** セッション ID の形式はハーネスごとに違う（Claude は UUID）ので、明らかにおかしいものだけを拒否する */
function checkSessionId(id: string): string {
  if (id === "") throw new Error("--session-id の値が空です")
  if (id.length > MAX_SESSION_ID) throw new Error(`--session-id の値が長すぎます（${MAX_SESSION_ID} 文字まで）`)
  if (/[\s\p{Cc}]/u.test(id)) throw new Error("--session-id の値に空白か制御文字が含まれています")
  return id
}
