// テスト用の偽の ACP エージェント。startHarness から子プロセスとして起動する。
// 振る舞いは環境変数 FAKE_ACP（JSON）で決め、受けた要求は 1 行ずつ "REQ <JSON>" として stderr に書く
// （stderr は startHarness が harness.log へ書くので、テストはそれを読む）。

import * as acp from "@agentclientprotocol/sdk"

export type FakeAcpConfig = {
  /** sessionCapabilities.resume を宣言する */
  resume?: boolean
  /** loadSession を宣言する */
  load?: boolean
  /** sessionCapabilities.list を宣言する。一覧は 1 ページに 1 件ずつ返す */
  list?: boolean
  /** 保存済みのセッション。mode は会話記録の最後のモード */
  sessions?: { id: string; cwd: string; mode: string }[]
}

const cfg: FakeAcpConfig = JSON.parse(process.env.FAKE_ACP ?? "{}")
const sessions = cfg.sessions ?? []
const MODES = ["default", "auto", "acceptEdits", "plan"].map((id) => ({ id, name: id }))

function record(method: string, params: unknown): void {
  process.stderr.write(`REQ ${JSON.stringify({ method, params })}\n`)
}

function modes(currentModeId: string) {
  return { currentModeId, availableModes: MODES }
}

function find(id: string, cwd: string) {
  const s = sessions.find((s) => s.id === id && s.cwd === cwd)
  if (!s) throw acp.RequestError.sessionNotFound(id)
  return s
}

const app = acp
  .agent({ name: "fake-acp" })
  .onRequest("initialize", ({ params }) => {
    record("initialize", params)
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        mcpCapabilities: { http: true },
        loadSession: cfg.load ?? false,
        sessionCapabilities: { ...(cfg.resume ? { resume: {} } : {}), ...(cfg.list ? { list: {} } : {}) },
      },
      agentInfo: { name: "fake-acp", version: "0.0.0" },
    }
  })
  .onRequest("session/new", ({ params }) => {
    record("session/new", params)
    // claude-agent-acp と同じく、指定がなければ auto で始める
    return { sessionId: "new-session", modes: modes("auto") }
  })
  .onRequest("session/list", ({ params }) => {
    record("session/list", params)
    const matched = sessions.filter((s) => params.cwd == null || s.cwd === params.cwd)
    const at = Number(params.cursor ?? 0)
    const page = matched.slice(at, at + 1).map((s) => ({ sessionId: s.id, cwd: s.cwd }))
    return { sessions: page, ...(at + 1 < matched.length ? { nextCursor: String(at + 1) } : {}) }
  })
  .onRequest("session/resume", ({ params }) => {
    record("session/resume", params)
    return { modes: modes(find(params.sessionId, params.cwd).mode) }
  })
  .onRequest("session/load", async ({ params, client }) => {
    record("session/load", params)
    const s = find(params.sessionId, params.cwd)
    // 仕様どおり、応答の前に履歴を session/update で再送する
    const updates: acp.SessionUpdate[] = [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "OLD REQUEST" } },
      { sessionUpdate: "tool_call", toolCallId: "old-tool", title: "OLD TOOL" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OLD ANSWER" } },
    ]
    for (const update of updates) await client.notify("session/update", { sessionId: s.id, update })
    return { modes: modes(s.mode) }
  })
  .onRequest("session/set_mode", ({ params }) => {
    record("session/set_mode", params)
    return {}
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    record("session/prompt", params)
    await client.notify("session/update", {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NEW ANSWER" } },
    })
    return { stopReason: "end_turn" }
  })

const output = new WritableStream<Uint8Array>({
  write(chunk) {
    process.stdout.write(chunk)
  },
})
await app.connect(acp.ndJsonStream(output, Bun.stdin.stream())).closed
