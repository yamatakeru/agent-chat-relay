// Chatwork の API のモック。Bot の投稿を sent.jsonl に記録する。発言は POST /_say で入れる（e2e から呼ぶ）。
// force=0 の差分は、ルームごとに、前回の取得より後に入った発言を返す（Bot 自身の投稿も含む）
import { appendFileSync } from "node:fs"
import { png } from "../fixtures/png.ts"

const log = process.argv[2]!
const ME = { account_id: 100, name: "AI係" }
const NAMES: Record<number, string> = { 1: "アリス", 2: "ボブ", 100: ME.name }
type Room = { room_id: number; name: string; type: string; last_update_time: number }
type Msg = { message_id: string; account: { account_id: number; name: string }; body: string; send_time: number; update_time: number }
const rooms: Room[] = [
  { room_id: 7000, name: "開発チーム", type: "group", last_update_time: 0 },
  { room_id: 7001, name: "アリス", type: "direct", last_update_time: 0 },
  { room_id: 7003, name: "営業チーム", type: "group", last_update_time: 0 },
]
const messages = new Map<number, Msg[]>()
const cursor = new Map<number, number>()
let seq = 1000
const now = () => Math.floor(Date.now() / 1000)
const PNG = png(32, 32, [220, 20, 20])
const record = (o: object) => appendFileSync(log, JSON.stringify(o) + "\n")

function add(roomId: number, account: number, body: string, at = now()): string {
  const id = String(++seq)
  messages.set(roomId, [...(messages.get(roomId) ?? []), { message_id: id, account: { account_id: account, name: NAMES[account] ?? "?" }, body, send_time: at, update_time: 0 }])
  const r = rooms.find((x) => x.room_id === roomId)!
  r.last_update_time = Math.max(r.last_update_time, at)
  return id
}

// 中継の起動前に届いていた依頼（記録だけされ、エージェントには渡らないはず）
add(7000, 1, "[To:100]AI係さん\n停止中に送った依頼：合言葉は「すずらん」", now() - 600)

Bun.serve({
  hostname: "127.0.0.1",
  port: 18098,
  async fetch(req) {
    const p = new URL(req.url).pathname
    if (req.method === "POST" && p === "/_say") {
      const b = new URLSearchParams(await req.text())
      return Response.json({ id: add(Number(b.get("room")), Number(b.get("account")), b.get("body") ?? "") })
    }
    if (req.method === "POST" && p === "/_join") {
      const b = new URLSearchParams(await req.text())
      rooms.push({ room_id: Number(b.get("room")), name: b.get("name") ?? "", type: "group", last_update_time: now() })
      return Response.json({})
    }
    if (req.method === "GET") {
      if (p === "/me") return Response.json(ME)
      if (p === "/rooms") return Response.json(rooms)
      if (p === "/contacts") return Response.json([{ account_id: 1, room_id: 7001, name: "アリス" }])
      let m = /^\/rooms\/(\d+)\/messages$/.exec(p)
      if (m) {
        const id = Number(m[1])
        const all = messages.get(id) ?? []
        const list = all.slice(cursor.get(id) ?? 0)
        cursor.set(id, all.length)
        return list.length ? Response.json(list) : new Response(null, { status: 204 })
      }
      m = /^\/rooms\/(\d+)\/messages\/(\d+)$/.exec(p)
      if (m) return Response.json((messages.get(Number(m[1])) ?? []).find((x) => x.message_id === m![2]))
      m = /^\/rooms\/\d+\/files\/(\d+)$/.exec(p)
      if (m) return Response.json({ file_id: Number(m[1]), filename: "photo.png", filesize: PNG.length, download_url: `http://127.0.0.1:18098/dl/${m[1]}` })
      if (p.startsWith("/dl/")) return new Response(PNG, { headers: { "Content-Type": "image/png" } })
    }
    let m = /^\/rooms\/(\d+)\/messages$/.exec(p)
    if (req.method === "POST" && m) {
      const body = new URLSearchParams(await req.text()).get("body") ?? ""
      record({ kind: "message", room: Number(m[1]), body: body.slice(0, 300) })
      return Response.json({ message_id: add(Number(m[1]), ME.account_id, body) })
    }
    m = /^\/rooms\/(\d+)\/files$/.exec(p)
    if (req.method === "POST" && m) {
      const form = await req.formData()
      const file = form.get("file") as File
      const message = String(form.get("message") ?? "")
      record({ kind: "file", room: Number(m[1]), file: file.name, size: file.size, content: (await file.text()).slice(0, 100), message: message.slice(0, 300) })
      add(Number(m[1]), ME.account_id, `${message}[info][title][dtext:file_uploaded][/title][download:${++seq}]${file.name} (1 KB)[/download][/info]`)
      return Response.json({ file_id: seq })
    }
    m = /^\/rooms\/(\d+)\/messages\/(\d+)$/.exec(p)
    if (req.method === "PUT" && m) {
      record({ kind: "edit", room: Number(m[1]), id: m[2] })
      return Response.json({ message_id: m[2] })
    }
    return new Response("not found", { status: 404 })
  },
})
