// ハーネスを ACP で動かす（ADR 0006）。中継が ACP のクライアントになり、ハーネスを子プロセスとして起動する。
// セッションは 1 つ。チャット用ツールの MCP サーバーを session/new（再開なら session/resume か session/load）で渡し、発言は session/prompt で入れる。

import * as acp from "@agentclientprotocol/sdk"
import type { Log, PermissionRequest, Session, Verdict } from "../core/relay.ts"
import { RotatingFile } from "./log-file.ts"

export type HarnessConfig = {
  command: string[]
  env?: Record<string, string>
  /** セッションの作業場所（絶対パス） */
  cwd: string
  mcp: { url: string; token: string }
  /** 再開するセッションの ID。なければ新しく作る。作業場所（cwd）で作ったセッションだけを再開する */
  sessionId?: string
  /** session/new・session/resume・session/load の _meta（ハーネス固有の設定。Claude Code の設定の読み込みなど） */
  meta?: Record<string, unknown>
  /**
   * セッションのモード（ACP の session mode）。違うモードで始まったら、最初の発言の前に切り替える。安全境界。
   * 再開でも会話記録のモードは引き継がない（権限は会話ではなく、中継の起動設定に属する。docs/relay.md）
   */
  mode?: string
  /** ハーネスの stderr を追記するファイル。画面には出さない。10MB を超えそうになったら <path>.1 に移して新しく始める */
  stderrPath: string
}

const MAX_STDERR_BYTES = 10 * 1024 * 1024

export async function startHarness(
  cfg: HarnessConfig,
  onPermission: (req: PermissionRequest) => Promise<Verdict>,
  log: Log,
): Promise<{ session: Session; exited: Promise<number>; stop: () => void }> {
  // stderr はファイルへ直接つながず、中継が受けて書く。大きさを数えて入れ替えるため
  const stderrLog = new RotatingFile(cfg.stderrPath, MAX_STDERR_BYTES)
  const proc = Bun.spawn(cfg.command, {
    cwd: cfg.cwd,
    // 中継の秘密情報（LINE のトークンなど）をハーネスへ渡さない。渡すと、エージェントが送信先の制限を迂回できる
    env: { ...withoutRelaySecrets(process.env), ...cfg.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderrDrained = (async () => {
    let failed = false
    try {
      // 書けなくても読み続ける。読むのをやめると、パイプが詰まってハーネスが止まる
      for await (const chunk of proc.stderr) {
        try {
          stderrLog.write(chunk)
        } catch (err) {
          if (!failed) log.error("harness.log に書けませんでした", { error: String(err) })
          failed = true
        }
      }
    } finally {
      stderrLog.close()
    }
  })()
  const stdin = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk)
      proc.stdin.flush()
    },
    close() {
      proc.stdin.end()
    },
  })
  const stream = acp.ndJsonStream(stdin, proc.stdout as ReadableStream<Uint8Array>)

  let turnText = ""
  // session/load が応答の前に再送する履歴は、新しい出力として扱わない
  let replaying = false
  const app = acp
    .client({ name: "agent-chat-relay" })
    .onRequest("session/request_permission", async ({ params }) => {
      const tc = params.toolCall
      const title = tc.title ?? tc.kind ?? "ツールの実行"
      const input = tc.rawInput === undefined ? "" : JSON.stringify(tc.rawInput, null, 2)
      const verdict = await onPermission({ title, input })
      // 「常に許可」は選ばない。毎回、承認者に尋ねる
      const kind = verdict === "allow" ? "allow_once" : "reject_once"
      const option = params.options.find((o) => o.kind === kind)
      log.info(`実行承認：${verdict}`, { tool: title })
      if (!option) return { outcome: { outcome: "cancelled" } }
      return { outcome: { outcome: "selected", optionId: option.optionId } }
    })
    .onNotification("session/update", ({ params }) => {
      if (replaying) return
      const u = params.update
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") turnText += u.content.text
      if (u.sessionUpdate === "tool_call") log.info(`ツール：${u.title}`)
    })

  const ready = Promise.withResolvers<Session>()
  const done = Promise.withResolvers<void>()
  void app
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "agent-chat-relay", version: "0.1.0" },
      })
      if (!init.agentCapabilities?.mcpCapabilities?.http) {
        throw new Error("このハーネスは HTTP の MCP サーバーに対応していません")
      }
      const { sessionId, modes, start } = await openSession(ctx, init.agentCapabilities, cfg, log, (on) => (replaying = on))
      let mode = modes?.currentModeId
      if (cfg.mode && mode !== cfg.mode) {
        if (!modes?.availableModes.some((m) => m.id === cfg.mode)) throw new Error(`モード ${cfg.mode} を使えません（今は ${mode}）`)
        await ctx.request("session/set_mode", { sessionId, modeId: cfg.mode })
        log.info(`モードを ${mode} から ${cfg.mode} に切り替えました`)
        mode = cfg.mode
      }
      log.info(start === "new" ? "セッションを開始しました" : "セッションを再開しました", {
        sessionId,
        start,
        agent: init.agentInfo?.name,
        version: init.agentInfo?.version,
        protocol: init.protocolVersion,
        mode,
      })
      ready.resolve({
        async prompt(text) {
          turnText = ""
          const res = await ctx.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] })
          // reply を使わずに書いた文章はチャットに届かない。気づけるようにログに出す
          if (turnText.trim()) log.info("ターンの出力（チャットには届いていない）", { stopReason: res.stopReason, text: turnText.trim().slice(0, 300) })
        },
      })
      await done.promise
    })
    .catch((err) => {
      ready.reject(err)
      // 始められなかったハーネスを残さない
      proc.kill()
    })

  // stderr を書き終えてから終了を知らせる（異常終了のとき、呼び出し側がログの末尾を読む）
  const exited = Promise.all([proc.exited, stderrDrained.catch(() => {})]).then(([code]) => {
    done.resolve()
    ready.reject(new Error(`ハーネスが終了しました（終了コード ${code}）`))
    return code
  })
  return { session: await ready.promise, exited, stop: () => proc.kill() }
}

type Opened = { sessionId: string; modes?: acp.SessionModeState | null; start: "new" | "resume" | "load" }

/**
 * セッションを新しく作るか、cfg.sessionId のセッションを再開する（docs/relay.md の「セッションの再開」）。
 * resume を優先し（履歴を再送しない）、失敗しても load には切り替えず、新しくも作らない
 */
async function openSession(
  ctx: acp.ClientContext,
  caps: acp.AgentCapabilities | undefined,
  cfg: HarnessConfig,
  log: Log,
  setReplaying: (on: boolean) => void,
): Promise<Opened> {
  // 再開でも、起動ごとの MCP の認証情報と _meta（設定の読み込み）を毎回渡す
  const setup: acp.NewSessionRequest = {
    cwd: cfg.cwd,
    mcpServers: [{ type: "http", name: "chat", url: cfg.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${cfg.mcp.token}` }] }],
    ...(cfg.meta ? { _meta: cfg.meta } : {}),
  }
  const sessionId = cfg.sessionId
  if (sessionId === undefined) return { ...(await ctx.request("session/new", setup)), start: "new" }

  const start = caps?.sessionCapabilities?.resume ? "resume" : caps?.loadSession ? "load" : undefined
  if (!start) throw new Error("このハーネスは、セッションの再開（session/resume・session/load）に対応していません")
  // 作業場所で作ったセッションだけを再開する。一覧で確かめられなければハーネスに任せる
  if (!caps?.sessionCapabilities?.list) {
    log.info("ハーネスがセッションの一覧に対応していないため、作業場所のセッションかどうかは確かめずに再開します", { sessionId })
  } else if (!(await listed(ctx, sessionId, cfg.cwd))) {
    throw new Error(`作業場所のセッションに ${sessionId} がありません。再開できるのは、中継の作業場所（${cfg.cwd}）で作ったセッションだけです`)
  }
  try {
    if (start === "resume") return { sessionId, modes: (await ctx.request("session/resume", { sessionId, ...setup })).modes, start }
    setReplaying(true)
    try {
      return { sessionId, modes: (await ctx.request("session/load", { sessionId, ...setup }))?.modes, start }
    } finally {
      setReplaying(false)
    }
  } catch (err) {
    throw new Error(`セッション ${sessionId} を再開できませんでした（session/${start}）: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 作業場所を cwd にした session/list に、その ID があるか。全ページを読む */
async function listed(ctx: acp.ClientContext, sessionId: string, cwd: string): Promise<boolean> {
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const page = await ctx.request("session/list", { cwd, ...(cursor ? { cursor } : {}) })
    if (page.sessions.some((s) => s.sessionId === sessionId)) return true
    cursor = page.nextCursor ?? undefined
    // 最後のページか、同じカーソルが戻ってきたら終える
    if (cursor === undefined || seen.has(cursor)) return false
    seen.add(cursor)
  }
}

export function withoutRelaySecrets(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(RELAY_|DOTENV_)/.test(k)))
}
