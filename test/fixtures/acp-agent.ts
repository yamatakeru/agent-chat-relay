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
  /** _session/steering を宣言し、この結果を返す（claude-agent-acp などの拡張） */
  steering?: "injected" | "promptRequired" | "startedNewTurn"
  /** session/new のあと、stdin を読むのをやめ、0.5 秒後に終了コード 3 で終わる（固まってから落ちるハーネス） */
  hang?: boolean
  /** session/prompt を受けたら、答えずに終了コード 4 で終わる（作業中に落ちるハーネス） */
  crash?: boolean
  /**
   * session/prompt の中で、この種類と選択肢で session/request_permission を送る。
   * 中継の答えは "PERM <JSON>" として stderr に書く
   */
  permission?: {
    kind?: acp.ToolKind
    options: acp.PermissionOption[]
    /** ツールの名前（title）と入力（rawInput）を付けない */
    bare?: boolean
    /** 承認依頼の前に、エージェントの文として流す */
    agentText?: string
  }
}

const cfg: FakeAcpConfig = JSON.parse(process.env.FAKE_ACP ?? "{}")
const sessions = cfg.sessions ?? []
/** false にすると、stdin を読むのをやめる（hang） */
let reading = true
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
    // 中継から受け取った環境変数の名前（秘密情報を渡していないことを確かめるため）
    process.stderr.write(`ENV ${JSON.stringify(Object.keys(process.env).sort())}\n`)
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        mcpCapabilities: { http: true },
        loadSession: cfg.load ?? false,
        sessionCapabilities: { ...(cfg.resume ? { resume: {} } : {}), ...(cfg.list ? { list: {} } : {}) },
      },
      agentInfo: { name: "fake-acp", version: "0.0.0" },
      ...(cfg.steering ? { _meta: { steering: { supported: true } } } : {}),
    }
  })
  .onRequest("session/new", ({ params }) => {
    record("session/new", params)
    if (cfg.hang) {
      reading = false
      setTimeout(() => process.exit(3), 500)
    }
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
    if (cfg.crash) process.exit(4)
    if (cfg.permission) {
      if (cfg.permission.agentText) {
        await client.notify("session/update", {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: cfg.permission.agentText } },
        })
      }
      const res = await client.request("session/request_permission", {
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: "tool-1",
          kind: cfg.permission.kind,
          ...(cfg.permission.bare ? {} : { title: "Bash", rawInput: { command: "ls" } }),
        },
        options: cfg.permission.options,
      })
      process.stderr.write(`PERM ${JSON.stringify(res)}\n`)
    }
    await client.notify("session/update", {
      sessionId: params.sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "NEW ANSWER" } },
    })
    return { stopReason: "end_turn" }
  })
  .onRequest("_session/steering", (params: unknown) => params, ({ params }) => {
    record("_session/steering", params)
    return { outcome: cfg.steering }
  })

// hang のときに読むのをやめられるように、stdin を包む
const stdin = Bun.stdin.stream().getReader()
const input = new ReadableStream<Uint8Array>({
  async pull(controller) {
    if (!reading) return new Promise<void>(() => {})
    const { done, value } = await stdin.read()
    if (done) controller.close()
    else controller.enqueue(value)
  },
})

const output = new WritableStream<Uint8Array>({
  write(chunk) {
    process.stdout.write(chunk)
  },
})
await app.connect(acp.ndJsonStream(output, input)).closed
