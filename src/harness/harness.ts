// ハーネスを ACP で動かす（ADR 0006）。中継が ACP のクライアントになり、ハーネスを子プロセスとして起動する。
// セッションは 1 つ。チャット用ツールの MCP サーバーを session/new で渡し、発言は session/prompt で入れる。

import * as acp from "@agentclientprotocol/sdk"
import type { Log, PermissionRequest, Session, Verdict } from "../core/relay.ts"
import { RotatingFile } from "./log-file.ts"

export type HarnessConfig = {
  command: string[]
  env?: Record<string, string>
  /** セッションの作業場所（絶対パス） */
  cwd: string
  mcp: { url: string; token: string }
  /** session/new の _meta（ハーネス固有の設定。Claude Code の設定の読み込みなど） */
  meta?: Record<string, unknown>
  /** セッションのモード（ACP の session mode）。違うモードで始まったら切り替える。安全境界 */
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
      const created = await ctx.request("session/new", {
        cwd: cfg.cwd,
        mcpServers: [
          { type: "http", name: "chat", url: cfg.mcp.url, headers: [{ name: "Authorization", value: `Bearer ${cfg.mcp.token}` }] },
        ],
        ...(cfg.meta ? { _meta: cfg.meta } : {}),
      })
      let mode = created.modes?.currentModeId
      if (cfg.mode && mode !== cfg.mode) {
        if (!created.modes?.availableModes.some((m) => m.id === cfg.mode)) throw new Error(`モード ${cfg.mode} を使えません（今は ${mode}）`)
        await ctx.request("session/set_mode", { sessionId: created.sessionId, modeId: cfg.mode })
        log.info(`モードを ${mode} から ${cfg.mode} に切り替えました`)
        mode = cfg.mode
      }
      log.info("セッションを開始しました", { agent: init.agentInfo?.name, version: init.agentInfo?.version, protocol: init.protocolVersion, mode })
      ready.resolve({
        async prompt(text) {
          turnText = ""
          const res = await ctx.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text }] })
          // reply を使わずに書いた文章はチャットに届かない。気づけるようにログに出す
          if (turnText.trim()) log.info("ターンの出力（チャットには届いていない）", { stopReason: res.stopReason, text: turnText.trim().slice(0, 300) })
        },
      })
      await done.promise
    })
    .catch((err) => ready.reject(err))

  // stderr を書き終えてから終了を知らせる（異常終了のとき、呼び出し側がログの末尾を読む）
  const exited = Promise.all([proc.exited, stderrDrained.catch(() => {})]).then(([code]) => {
    done.resolve()
    ready.reject(new Error(`ハーネスが終了しました（終了コード ${code}）`))
    return code
  })
  return { session: await ready.promise, exited, stop: () => proc.kill() }
}

export function withoutRelaySecrets(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !/^(RELAY_|CCJ_|DOTENV_)/.test(k)))
}
