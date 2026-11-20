import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { approvePiToolCall } from "../../harness/pi/tool-approval.ts"
import { managedRead } from "./managed-read.ts"

const required = ["reply", "fetch_messages", "download_attachment", "list_rooms"]
const chatTools = new Set([...required, "react", "edit_message", "create_thread"])
const builtinTools = ["read", "write", "edit", "bash"]
export const managedToolSelection = [...builtinTools, ...[...chatTools].map(name => `mcp__chat__${name}`)]
export const managedExtensionName = "relay-managed-chat"

export function managedChat({ url, authorization }: { url: string; authorization: string }, workspace: string, stateDir: string): ExtensionFactory {
  return async (pi) => {
    const client = new Client({ name: "agent-chat-relay-pi", version: "1" })
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: authorization } },
      fetch: (resource, options) => fetch(resource, { ...options, redirect: "error" }),
    })
    const session = new AbortController()
    const registered = new Set<string>()
    let ready = false
    const read = managedRead(workspace, stateDir, session.signal)
    pi.registerTool(read)
    const owns = (name: string) => pi.getAllTools().some(tool =>
      tool.name === name && tool.sourceInfo.path === `<inline:${managedExtensionName}>`)
    pi.on("tool_call", (event, ctx) => {
      if (!ready) return { block: true, reason: "チャット用ツールの準備ができていません" }
      // 継承した拡張が同名でも、承認を省くのは中継が登録したツールだけ。
      if (event.toolName === read.name || registered.has(event.toolName)) {
        if (owns(event.toolName)) return
        return { block: true, reason: "中継のツールを確認できません" }
      }
      return approvePiToolCall(event, ctx, { sessionSignal: session.signal })
    })
    try {
      await client.connect(transport, { timeout: 2500 })
      if (client.getServerVersion()?.name !== "chat") throw new Error()
      const { tools, nextCursor } = await client.listTools(undefined, { timeout: 2500 })
      // 中継が提供するチャット用ツールの 1 ページだけを受け付ける。
      const names = new Set(tools.map(tool => tool.name))
      if (nextCursor || names.size !== tools.length || !required.every(name => names.has(name)) || tools.some(tool => !chatTools.has(tool.name))) {
        throw new Error()
      }
      for (const tool of tools) {
        const name = `mcp__chat__${tool.name}`
        pi.registerTool({
          name,
          label: tool.name,
          description: tool.description ?? tool.name,
          parameters: tool.inputSchema,
          async execute(_id, args, signal) {
            if (!ready) throw new Error("チャット用ツールの準備ができていません")
            try {
              const result = await client.callTool({ name: tool.name, arguments: { ...args } }, undefined, { timeout: 5000, signal })
              if (result.isError || !Array.isArray(result.content)) throw new Error()
              const content = result.content.map(item => {
                if (item.type !== "text") throw new Error()
                return { type: "text" as const, text: item.text }
              })
              return { content, details: {} }
            } catch {
              // ヘッダー等を含み得る例外は RPC やモデルへ送らない。
              throw new Error("チャット用ツールの MCP 呼び出しに失敗しました")
            }
          },
        })
        registered.add(name)
      }
      pi.on("session_start", (_event, ctx) => {
        const expected = [...builtinTools, ...registered]
        const active = new Set(pi.getActiveTools())
        ready = owns(read.name) && [...registered].every(owns) && active.size === expected.length && expected.every(name => active.has(name))
        ctx.ui.notify(ready ? "managed-chat:ready" : "managed-chat:failed", ready ? "info" : "error")
      })
      pi.on("session_shutdown", async () => {
        ready = false
        session.abort()
        await client.close().catch(() => {})
      })
    } catch {
      await client.close().catch(() => {})
      throw new Error("チャット用ツールの MCP 初期化に失敗しました")
    }
  }
}
