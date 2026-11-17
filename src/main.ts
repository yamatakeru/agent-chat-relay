// agent-chat-relay のエントリーポイント。scripts/relay.sh から、秘密情報を環境変数に設定した状態で呼ばれる。
//
//   serve [harness] [--session-id <id>]
//                  中継を起動する（チャットサービスのコネクター、チャット用ツールの MCP、ハーネス）。
//                  harness の既定は RELAY_HARNESS、なければ claude。--session-id で、そのセッションを再開する
//   pair <code>    ペアリングのコードを承認する（ルームの登録、DM の相手の許可）
//   access         登録したルームと許可した人の一覧（ID は伏せる）

import { randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { AccessStore, localId, serviceOf } from "./core/access.ts"
import { chatworkFromEnv } from "./connectors/chatwork.ts"
import { discordFromEnv } from "./connectors/discord.ts"
import { lineFromEnv } from "./connectors/line.ts"
import { harnessConfig, harnessOptionsFromEnv } from "./harness/config.ts"
import { startHarness } from "./harness/harness.ts"
import { schedulePrune } from "./core/retention.ts"
import { mcpHandler } from "./core/mcp.ts"
import { parseServeArgs, type ServeArgs } from "./serve-args.ts"
import { type ConnectorFactory, type Log, Relay, type Routes } from "./core/relay.ts"
import { resolveWorkspace } from "./workspace.ts"

/** コネクターの一覧。秘密情報のあるものだけを動かす */
const CONNECTORS: ConnectorFactory[] = [lineFromEnv, chatworkFromEnv, discordFromEnv]

const home = resolve(process.env.RELAY_HOME ?? ".local/relay")
/** リポジトリ直下。既定の秘密情報（.env・.env.keys）の置き場 */
const REPO_ROOT = resolve(import.meta.dir, "..")
const accessPath = join(home, "access.json")

const format = (msg: string, extra?: Record<string, unknown>) => `${new Date().toISOString()} relay: ${msg}${extra ? ` ${JSON.stringify(extra)}` : ""}`
const log: Log = {
  info: (msg, extra) => console.log(format(msg, extra)),
  error: (msg, extra) => console.error(format(msg, extra)),
}

async function serve(access: AccessStore, args: ServeArgs): Promise<void> {
  // 不正な指定は、何も起動しないうちに拒否する
  const harnessOptions = harnessOptionsFromEnv(process.env)
  // 作業ディレクトリの中は承認なしで読めて返せるので、中継のデータと秘密情報の置き場を含めない（ADR 0017）
  const envFile = resolve(process.env.RELAY_ENV_FILE ?? join(REPO_ROOT, ".env"))
  const { path: workspace, specified } = resolveWorkspace(process.env, home, [home, REPO_ROOT, dirname(envFile)])
  if (specified) log.info("管理者が指定した作業ディレクトリを使います", { workspace })
  const inbox = join(workspace, ".relay", "inbox")

  // 受け取った添付は 7 日で消す（ADR 0005）
  schedulePrune(inbox, "受け取った添付", log)

  const relay = new Relay(access, log, workspace)
  const connectors = CONNECTORS.map((make) => make(process.env, { relay, log, home })).filter((c) => c !== undefined)
  if (connectors.length === 0) {
    throw new Error("チャットサービスの秘密情報がありません。scripts/relay.sh secrets line・secrets chatwork・secrets discord のどれかを実行してください")
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

  // コネクターのエンドポイント（Webhook など）は、1 つのサーバーにまとめる。外へはトンネルで公開する。同じパスを 2 つのコネクターが出したら起動しない
  const routes: Routes = {}
  for (const c of connectors) {
    for (const [path, route] of Object.entries(c.routes ?? {})) {
      if (path in routes) throw new Error(`受け口の道が重なっています: ${path}（${c.label}）`)
      routes[path] = route
    }
  }
  if (Object.keys(routes).length > 0) {
    const http = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(process.env.RELAY_HTTP_PORT ?? 18080),
      routes,
      fetch: () => new Response("not found", { status: 404 }),
    })
    closers.push(() => void http.stop())
    log.info("コネクターの受け口を開きました", { url: http.url.href, routes: Object.keys(routes) })
  }
  await Promise.all(connectors.map((c) => c.start()))
  for (const c of connectors) closers.push(() => c.stop())

  const { harness: harnessName, sessionId } = args
  const harnessLog = join(home, "harness.log")
  const harness = await startHarness(
    { ...harnessConfig(harnessName, workspace, { url: `${mcp.url}mcp`, token }, harnessOptions, log, specified), sessionId, stderrPath: harnessLog },
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
  // サービス名と、ローカル ID の先頭 1 文字（LINE の C・R・U、Chatwork の r・u、Discord の c・u）だけを残す
  return `${serviceOf(id)}:${localId(id).slice(0, 1)}…`
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  const arg = rest[0]
  const access = new AccessStore(accessPath)
  switch (cmd) {
    case "serve":
      // 不正な引数は、何も起動しないうちに拒否する
      return serve(access, parseServeArgs(rest, process.env.RELAY_HARNESS ?? "claude"))
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
      throw new Error("usage: relay serve [harness] [--session-id <id>] | pair <code> | access")
  }
}

main().catch((err) => {
  console.error(`relay: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
