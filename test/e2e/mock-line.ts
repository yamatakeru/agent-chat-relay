// LINE の Messaging API のモック。送信を sent.jsonl に記録し（文面は 2000 文字まで。承認依頼の ID が切れないように）、画像の本体として赤い PNG を返す。
// 待ち受けのポートは MOCK_LINE_PORT（既定 18099）。環境変数 MOCK_LINE_HOLD に文字列を渡すと、それを含む送信は、記録してから MOCK_LINE_HOLD_MS（既定 30 秒）待って応える（送信が詰まった場面を作る）
import { appendFileSync } from "node:fs"
import { png } from "../fixtures/png.ts"
const log = process.argv[2]!
let n = 0
const PNG = png(32, 32, [220, 20, 20])
Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.MOCK_LINE_PORT ?? 18099), idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === "GET" && url.pathname.endsWith("/content")) return new Response(PNG, { headers: { "Content-Type": "image/png" } })
    if (req.method === "GET" && url.pathname.endsWith("/summary")) return Response.json({ groupName: url.pathname.includes("C111") ? "開発チーム" : "営業チーム" })
    if (req.method === "GET") return Response.json({ displayName: url.pathname.includes("Uaaa") ? "アリス" : url.pathname.includes("Uccc") ? "カオル" : "ボブ" })
    const body = await req.json() as { to?: string; replyToken?: string; messages?: { type: string; text?: string; quickReply?: unknown; originalContentUrl?: string }[] }
    const kind = url.pathname.split("/").pop()
    appendFileSync(log, JSON.stringify({ kind, to: body.to?.slice(0, 4), messages: body.messages?.map((m) => ({ type: m.type, text: m.text?.slice(0, 2000), quick: !!m.quickReply, image: m.originalContentUrl })) }) + "\n")
    const hold = process.env.MOCK_LINE_HOLD
    if (hold && body.messages?.some((m) => m.text?.includes(hold))) await Bun.sleep(Number(process.env.MOCK_LINE_HOLD_MS ?? 30_000))
    return Response.json({ sentMessages: (body.messages ?? []).map(() => ({ id: String(900000 + ++n), quoteToken: `q${n}` })) })
  },
})
