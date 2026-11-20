// pi 1.5.2 の tool_call と ui.confirm の接続に必要な部分だけを受ける。
type PiToolCall = { toolName: string; input: unknown }
type PiApprovalContext = {
  hasUI: boolean
  signal?: AbortSignal
  ui: { confirm(title: string, message: string, options: { timeout: number; signal: AbortSignal }): Promise<boolean> }
}
type PiApprovalOptions = { sessionSignal?: AbortSignal; timeoutMs?: number }
type Blocked = { block: true; reason: string }

// 中継の実行承認と同じ 30 分を上限にする（src/core/relay.ts の PERMISSION_TIMEOUT_MS）。
const MAX_APPROVAL_WAIT_MS = 30 * 60 * 1000

function textField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const value: unknown = Object.getOwnPropertyDescriptor(input, key)?.value
  if (typeof value === "string" && value.trim()) return value
}

/** 改行や表示方向を変える文字を、対象の一部として見える形にする。 */
function quoted(text: string): string {
  return JSON.stringify(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}`)
}

/** 操作と対象だけを ACP の承認依頼に渡す。ツールの入力全体は転送しない。 */
export function describePiToolCall({ toolName, input }: PiToolCall): { title: string; message: string } {
  if (toolName === "bash") {
    const command = textField(input, "command")
    return { title: "bash：シェルの実行", message: command === undefined ? "コマンドを確認できません" : `コマンド: ${quoted(command)}` }
  }
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    const path = textField(input, "path")
    const operation = { read: "ファイルの読み取り", write: "ファイルの作成・上書き", edit: "ファイルの編集" }[toolName]
    return { title: `${toolName}：${operation}`, message: path === undefined ? "対象パスを確認できません" : `対象パス: ${quoted(path)}` }
  }
  return { title: "その他のツールの実行", message: `ツール: ${quoted(toolName)}（対象を確認できません）` }
}

/** 実行承認を求める。承認を省けるかどうかは、実際の読み取りなどを担う呼び出し側で判断する。 */
export async function approvePiToolCall(
  event: PiToolCall,
  ctx: PiApprovalContext,
  { sessionSignal, timeoutMs = MAX_APPROVAL_WAIT_MS }: PiApprovalOptions = {},
): Promise<Blocked | undefined> {
  const blocked: Blocked = { block: true, reason: "実行が許可されませんでした" }
  const turnSignal = ctx.signal
  if (ctx.hasUI !== true || !turnSignal || turnSignal.aborted || sessionSignal?.aborted) return blocked
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_APPROVAL_WAIT_MS) return blocked

  const deadline = performance.now() + timeoutMs
  const timeout = new AbortController()
  const signal = AbortSignal.any(sessionSignal ? [turnSignal, sessionSignal, timeout.signal] : [turnSignal, timeout.signal])
  const timer = setTimeout(() => timeout.abort(), timeoutMs)
  const cancelled = Promise.withResolvers<boolean>()
  const cancel = () => cancelled.resolve(false)
  signal.addEventListener("abort", cancel, { once: true })
  try {
    const { title, message } = describePiToolCall(event)
    if (signal.aborted || performance.now() >= deadline) return blocked
    const confirmed = await Promise.race([ctx.ui.confirm(title, message, { timeout: timeoutMs, signal }), cancelled.promise])
    // タイマーのコールバックより先に届いた返事でも、期限後なら採用しない。
    if (confirmed === true && !signal.aborted && performance.now() < deadline) return
  } catch {
    // UI や接続のエラーは拒否と同じ扱いにし、入力を含み得るエラーを出力しない。
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", cancel)
  }
  return blocked
}
