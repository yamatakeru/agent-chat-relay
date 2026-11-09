// agent-chat-relay の入口。scripts/relay.sh から、秘密情報を環境変数に入れた状態で呼ばれる。
//
//   serve          中継を起動する（チャットサービスの接続部、チャット用ツールの MCP、ハーネス）
//   pair <code>    ペアリングのコードを承認する（ルームの登録、DM の相手の許可）
//   access         登録したルームと許可した人の一覧（ID は伏せる）

import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { AccessStore, localId, serviceOf } from "./core/access.ts"
import { chatworkFromEnv } from "./connectors/chatwork.ts"
import { lineFromEnv } from "./connectors/line.ts"
import { startHarness, type HarnessConfig } from "./harness/harness.ts"
import { pruneOld, RETENTION_MS } from "./core/retention.ts"
import { mcpHandler } from "./core/mcp.ts"
import { type Connector, type ConnectorDeps, type Log, Relay, type Routes } from "./core/relay.ts"

/** 接続部の一覧。秘密情報のあるものだけを動かす */
const CONNECTORS: ((env: Record<string, string | undefined>, deps: ConnectorDeps) => Connector | undefined)[] = [lineFromEnv, chatworkFromEnv]

const home = resolve(process.env.RELAY_HOME ?? ".local/relay")
const accessPath = join(home, "access.json")

const format = (msg: string, extra?: Record<string, unknown>) => `${new Date().toISOString()} relay: ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}`
const log: Log = {
  info: (msg, extra) => console.log(format(msg, extra)),
  error: (msg, extra) => console.error(format(msg, extra)),
}

/** ハーネスごとの起動方法。実行承認と設定の読み込みに関わる部分は安全境界（AGENTS.md） */
function harnessConfig(name: string, cwd: string, mcp: HarnessConfig["mcp"]): Omit<HarnessConfig, "stderrPath"> {
  switch (name) {
    case "claude": {
      const claude = Bun.which("claude")
      if (!claude) throw new Error("claude が見つかりません")
      return {
        // Agent SDK に同梱の CLI は入れていない（bunfig.toml）。インストール済みの claude を使う
        command: [process.execPath, resolve("node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")],
        env: { CLAUDE_CODE_EXECUTABLE: claude },
        cwd,
        mcp,
        mode: "default",
        meta: {
          claudeCode: {
            options: {
              // ユーザー設定（~/.claude/settings.json）の allow ルールや hooks を読み込ませない
              settingSources: ["project", "local"],
              settings: {
                // ユーザーや上位ディレクトリの CLAUDE.md・AGENTS.md と、自動メモリを読み込ませない
                claudeMdExcludes: ["**/AGENTS.md", "**/CLAUDE.md"],
                autoMemoryEnabled: false,
                // ツールを実行するたびに承認を求める。指定しないと、claude-agent-acp は auto モード（分類器による自動承認）で始める。
                // mcp__chat だけは承認なし（送り先は中継が、登録したルームと許可した DM に限る。ADR 0008）
                permissions: { defaultMode: "default", allow: ["mcp__chat"] },
              },
            },
          },
        },
      }
    }
    case "opencode": {
      // 今は実行承認が働かない（#6）。安全境界を割るので、明示しない限り起動しない
      if (process.env.RELAY_ALLOW_UNSAFE_HARNESS !== "1") {
        throw new Error("opencode では実行承認が働かない（#6）ため、RELAY_ALLOW_UNSAFE_HARNESS=1 がないと起動しません")
      }
      // 既定ではほぼすべてを承認なしで実行するので、すべて尋ねたうえで、読み取りとチャット用ツールだけを許す。
      // 組み込みの build エージェントの規則（* を許可）より後に効くよう、エージェントの規則として書く（後の規則ほど優先される）
      const config = {
        $schema: "https://opencode.ai/config.json",
        ...(process.env.RELAY_OPENCODE_MODEL ? { model: process.env.RELAY_OPENCODE_MODEL } : {}),
        agents: {
          build: {
            permissions: [
              { action: "*", resource: "*", effect: "ask" },
              ...["read", "glob", "grep", "subagent"].map((action) => ({ action, resource: "*", effect: "allow" })),
              { action: "chat_*", resource: "*", effect: "allow" },
              // 選択肢での質問は中継しない。チャットで尋ねさせる
              { action: "question", resource: "*", effect: "deny" },
              // 作業場所の外は、読み取りでも尋ねる
              { action: "external_directory", resource: "*", effect: "ask" },
            ],
          },
        },
      }
      writeFileSync(join(cwd, "opencode.json"), JSON.stringify(config, null, 2) + "\n")
      return { command: ["opencode", "acp"], cwd, mcp }
    }
    default:
      throw new Error(`知らないハーネスです: ${name}（claude か opencode）`)
  }
}

async function serve(access: AccessStore): Promise<void> {
  const workspace = join(home, "workspace")
  if (!existsSync(join(workspace, ".git"))) {
    // 作業場所を独立した git リポジトリにして、上位（このリポジトリ）の設定や AGENTS.md を拾わせない
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    Bun.spawnSync(["git", "init", "-q", workspace])
  }
  const inbox = join(workspace, ".relay", "inbox")

  // 受け取った添付は 7 日で消す（起動時と 1 時間ごと。ADR 0005）
  const prune = () => {
    const removed = pruneOld(inbox, RETENTION_MS)
    if (removed > 0) log.info("7 日を過ぎた添付を消しました", { removed })
  }
  prune()
  setInterval(prune, 60 * 60 * 1000).unref()

  const relay = new Relay(access, log, workspace)
  const connectors = CONNECTORS.map((make) => make(process.env, { relay, log, home })).filter((c) => c !== undefined)
  if (connectors.length === 0) {
    throw new Error("チャットサービスの秘密情報がありません。scripts/relay.sh secrets line か secrets chatwork を実行してください")
  }
  for (const c of connectors) relay.addConnector(c)

  const token = randomBytes(32).toString("base64url")
  const mcp = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.RELAY_MCP_PORT ?? 18090),
    idleTimeout: 0,
    routes: { "/mcp": mcpHandler(relay, inbox, token) },
    fetch: () => new Response("not found", { status: 404 }),
  })
  // 終了時に閉じるもの
  const closers: (() => void)[] = [() => void mcp.stop()]
  log.info("チャット用ツールの受け口を開きました", { mcp: `${mcp.url}mcp` })

  // 接続部の受け口（Webhook など）は、1 つのサーバーにまとめる。外へはトンネルで公開する
  const routes: Routes = Object.assign({}, ...connectors.map((c) => c.routes ?? {}))
  if (Object.keys(routes).length > 0) {
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(process.env.RELAY_HTTP_PORT ?? 18080),
      routes,
      fetch: () => new Response("not found", { status: 404 }),
    })
    closers.push(() => void http.stop())
    log.info("接続部の受け口を開きました", { url: http.url.href, routes: Object.keys(routes) })
  }
  for (const c of connectors) {
    await c.start()
    closers.push(() => c.stop())
  }

  const harnessName = process.env.RELAY_HARNESS ?? "claude"
  const harnessLog = join(home, "harness.log")
  const harness = await startHarness(
    { ...harnessConfig(harnessName, workspace, { url: `${mcp.url}mcp`, token }), stderrPath: harnessLog },
    (req) => relay.requestPermission(req),
    log,
  )
  relay.attach(harness.session)

  // Ctrl+C は、端末と dotenvx の両方から届くことがある
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    log.info("停止します")
    harness.stop()
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  const code = await harness.exited
  if (code === 0 || stopping) {
    log.info("ハーネスが終了したため、中継も止めます", { harness: harnessName, code })
  } else {
    const tail = readFileSync(harnessLog, "utf8").trimEnd().split("\n").slice(-20).join("\n")
    log.error(`ハーネスが異常終了したため、中継も止めます。ハーネスのログ：${harnessLog}（最後の 20 行を下に出す）`, { harness: harnessName, code })
    console.error(tail)
  }
  for (const close of closers) close()
  process.exit(code === 0 ? 0 : 1)
}

function mask(id: string): string {
  // サービス名と、ローカル ID の先頭 1 文字（LINE の C・R・U、Chatwork の r・u）だけを残す
  return `${serviceOf(id)}:${localId(id).slice(0, 1)}…`
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2)
  const access = new AccessStore(accessPath)
  switch (cmd) {
    case "serve":
      return serve(access)
    case "pair": {
      if (!arg) throw new Error("usage: relay pair <code>")
      const p = access.approve(arg)
      console.log(p.kind === "room" ? `ルームを登録しました: ${mask(p.target)}（受信モード：メンション時）` : `DM の相手を許可しました: ${mask(p.target)}（実行承認の依頼も届きます）`)
      return
    }
    case "access": {
      const a = access.load()
      console.log("ルーム:")
      for (const [room, p] of Object.entries(a.rooms)) console.log(`  ${mask(room)}  ${p.requireMention ? "メンション時" : "すべて"}${p.allowFrom.length ? `  許可 ${p.allowFrom.length} 人` : ""}`)
      console.log("DM と実行承認を許可した人:")
      for (const u of a.allowFrom) console.log(`  ${mask(u)}`)
      console.log(`ペアリング待ち: ${Object.keys(a.pending).length} 件`)
      return
    }
    default:
      throw new Error("usage: relay serve | pair <code> | access")
  }
}

main().catch((err) => {
  console.error(`relay: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
