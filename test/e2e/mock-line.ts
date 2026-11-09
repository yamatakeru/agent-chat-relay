// LINE の Messaging API のモック。送信を sent.jsonl に記録し、画像の本体として赤い PNG を返す
import { appendFileSync } from "node:fs"
import { png } from "../fixtures/png.ts"
const log = process.argv[2]!
let n = 0
const PNG = png(32, 32, [220, 20, 20])
Bun.serve({
  hostname: "127.0.0.1", port: 18099,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === "GET" && /\/content$/.test(url.pathname)) return new Response(PNG, { headers: { "Content-Type": "image/png" } })
    if (req.method === "GET" && /\/summary$/.test(url.pathname)) return Response.json({ groupName: url.pathname.includes("C111") ? "開発チーム" : "営業チーム" })
    if (req.method === "GET") return Response.json({ displayName: url.pathname.includes("Uaaa") ? "アリス" : "ボブ" })
    const body = await req.json() as { to?: string; replyToken?: string; messages?: { type: string; text?: string; quickReply?: unknown; originalContentUrl?: string }[] }
    const kind = url.pathname.split("/").pop()
    appendFileSync(log, JSON.stringify({ kind, to: body.to?.slice(0, 4), messages: body.messages?.map((m) => ({ type: m.type, text: m.text?.slice(0, 300), quick: !!m.quickReply, image: m.originalContentUrl })) }) + "\n")
    return Response.json({ sentMessages: (body.messages ?? []).map(() => ({ id: String(900000 + ++n), quoteToken: `q${n}` })) })
  },
})
