// LINE の Messaging API のモック。送信を sent.jsonl に記録し、画像の本体として赤い PNG を返す
import { appendFileSync } from "node:fs"
import { deflateSync } from "node:zlib"
const log = process.argv[2]!
let n = 0
const PNG = png()
function png(): Uint8Array {
  const w = 32, h = 32
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([220, 20, 20]))])))
  const crcTable = Array.from({ length: 256 }, (_, c) => { for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}
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
