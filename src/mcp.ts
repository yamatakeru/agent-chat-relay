// エージェントに渡すチャット用ツール（MCP）。どのハーネスにも同じものを渡す（ADR 0006）。
// ツールの名前と形は、公式の Claude Code Discord プラグインに揃えた。
// ハーネスとは 127.0.0.1 の HTTP でつなぎ、起動ごとに作る token で守る。

import { timingSafeEqual } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"
import { INSTRUCTIONS, type Relay } from "./relay.ts"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] }
}

async function run(name: string, op: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await op())
  } catch (err) {
    return { content: [{ type: "text", text: `${name} failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
  }
}

export function buildTools(relay: Relay, inboxDir: string): McpServer {
  const server = new McpServer({ name: "chat", version: "0.1.0" }, { instructions: INSTRUCTIONS })

  server.registerTool(
    "reply",
    {
      description: "チャットのルームへ送る。chat_id は届いた発言のもの、または list_rooms のもの。reply_to に message_id を渡すと、その発言を引用して返す（いちばん新しい発言への返事には要らない）。",
      inputSchema: {
        chat_id: z.string(),
        text: z.string(),
        reply_to: z.string().optional().describe("引用して返す発言の message_id"),
      },
    },
    ({ chat_id, text, reply_to }) =>
      run("reply", async () => {
        const ids = await relay.reply(chat_id, text, reply_to)
        return ids.length <= 1 ? `sent (id: ${ids[0] ?? "-"})` : `sent ${ids.length} parts (ids: ${ids.join(", ")})`
      }),
  )

  server.registerTool(
    "fetch_messages",
    {
      description: "ルームの最近の発言を、古い順に取得する。Bot に向けられていない発言も含む。中継が起動してからの分だけを持っている。",
      inputSchema: { chat_id: z.string(), limit: z.number().int().optional().describe("最大件数（既定 20、最大 100）") },
    },
    ({ chat_id, limit }) =>
      run("fetch_messages", async () => {
        const msgs = relay.fetchMessages(chat_id, limit ?? 20)
        if (msgs.length === 0) return "(no messages)"
        return msgs
          .map((m) => {
            const who = m.fromMe ? "me" : (m.senderName ?? m.sender)
            const atts = m.attachments.length > 0 ? ` +${m.attachments.length}att` : ""
            // 改行で行を偽装されないよう、1 行にまとめる（公式と同じ）
            return `[${new Date(m.ts).toISOString()}] ${who}: ${m.text.replace(/[\r\n]+/g, " ⏎ ")}  (id: ${m.id}${atts})`
          })
          .join("\n")
      }),
  )

  server.registerTool(
    "download_attachment",
    {
      description: "発言の添付（画像・ファイル）を取得し、読めるパスを返す。attachments 属性のある発言や、fetch_messages で +Natt と出た発言に使う。",
      inputSchema: { chat_id: z.string(), message_id: z.string() },
    },
    ({ chat_id, message_id }) =>
      run("download_attachment", async () => {
        const paths = await relay.download(chat_id, message_id, inboxDir)
        return `downloaded ${paths.length} attachment(s):\n${paths.map((p) => `  ${p}`).join("\n")}`
      }),
  )

  server.registerTool(
    "list_rooms",
    { description: "送れるルームと DM の一覧。", inputSchema: {} },
    () => run("list_rooms", async () => JSON.stringify(await relay.listRooms(), null, 2)),
  )

  server.registerTool(
    "react",
    { description: "発言に絵文字のリアクションを付ける（対応していないチャットサービスもある）。", inputSchema: { chat_id: z.string(), message_id: z.string(), emoji: z.string() } },
    ({ chat_id, message_id, emoji }) =>
      run("react", async () => {
        await relay.react(chat_id, message_id, emoji)
        return "reacted"
      }),
  )

  server.registerTool(
    "edit_message",
    {
      description: "Bot が送った発言を編集する（途中経過の更新などに。対応していないチャットサービスもある）。編集では通知が鳴らないので、作業が終わったら新しく reply する。",
      inputSchema: { chat_id: z.string(), message_id: z.string(), text: z.string() },
    },
    ({ chat_id, message_id, text }) =>
      run("edit_message", async () => {
        await relay.edit(chat_id, message_id, text)
        return "edited"
      }),
  )

  return server
}

/** /mcp の受け口。リクエストごとにツールの一式を作る（状態を持たない形） */
export function mcpHandler(relay: Relay, inboxDir: string, token: string): (req: Request) => Promise<Response> {
  const expected = Buffer.from(`Bearer ${token}`)
  return async (req) => {
    const given = Buffer.from(req.headers.get("authorization") ?? "")
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return new Response("unauthorized", { status: 401 })
    }
    const server = buildTools(relay, inboxDir)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(req)
  }
}
