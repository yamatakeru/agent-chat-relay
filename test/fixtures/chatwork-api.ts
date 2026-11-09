// Chatwork の API のモック。単体テストと e2e（test/e2e/mock-chatwork.ts）で使う。
// force=0 の差分は、ルームごとに、前回の取得より後に入った発言を返す（Bot 自身の投稿も含む）。
// Bot の投稿は sent に記録する。POST /_say・/_join で、発言とルームを足せる（e2e から呼ぶ）

export const BOT = { account_id: 100, name: "AI係" }
const NAMES: Record<number, string> = { 1: "アリス", 2: "ボブ", [BOT.account_id]: BOT.name }
const TYPES: Record<string, string> = { png: "image/png", txt: "text/plain", csv: "text/csv" }

type Room = { room_id: number; name: string; type: "group" | "direct"; last_update_time: number }
type Msg = { message_id: string; account: { account_id: number; name: string }; body: string; send_time: number; update_time: number }
/** Bot の投稿。kind は、発言（message）、ファイル（file）、編集（edit） */
export type Sent = { kind: "message" | "file" | "edit"; room: number; body: string; file?: string; size?: number; content?: string }

export function chatworkApi(opts: { port?: number; onSent?: (s: Sent) => void } = {}) {
  const rooms: Room[] = [
    { room_id: 7000, name: "開発チーム", type: "group", last_update_time: 0 },
    { room_id: 7001, name: "アリス", type: "direct", last_update_time: 0 },
    { room_id: 7003, name: "営業チーム", type: "group", last_update_time: 0 },
  ]
  const messages = new Map<number, Msg[]>()
  const cursor = new Map<number, number>()
  const files = new Map<string, { name: string; data: Uint8Array | string }>()
  const sent: Sent[] = []
  let seq = 1000
  let gets = 0
  const now = () => Math.floor(Date.now() / 1000)

  /** 発言を足し、そのメッセージ ID を返す。at は Unix 秒 */
  function say(roomId: number, account: number, body: string, at = now()): string {
    const id = String(++seq)
    const msg = { message_id: id, account: { account_id: account, name: NAMES[account] ?? "?" }, body, send_time: at, update_time: 0 }
    messages.set(roomId, [...(messages.get(roomId) ?? []), msg])
    const r = rooms.find((x) => x.room_id === roomId)!
    r.last_update_time = Math.max(r.last_update_time, at)
    return id
  }

  /** 取得できるファイルを置く。発言の [download:<fid>] から取れる */
  function addFile(fid: string, name: string, data: Uint8Array | string): void {
    files.set(fid, { name, data })
  }

  /** Bot が新しいグループチャットに追加された */
  function join(roomId: number, name: string): void {
    rooms.push({ room_id: roomId, name, type: "group", last_update_time: now() })
  }

  const record = (s: Sent) => {
    sent.push(s)
    opts.onSent?.(s)
  }

  const server: Bun.Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    async fetch(req) {
      const p = new URL(req.url).pathname
      if (req.method === "POST" && p === "/_say") {
        const b = new URLSearchParams(await req.text())
        return Response.json({ id: say(Number(b.get("room")), Number(b.get("account")), b.get("body") ?? "") })
      }
      if (req.method === "POST" && p === "/_join") {
        const b = new URLSearchParams(await req.text())
        join(Number(b.get("room")), b.get("name") ?? "")
        return Response.json({})
      }
      if (req.method === "GET") {
        if (p === "/me") return Response.json(BOT)
        if (p === "/rooms") return Response.json(rooms)
        if (p === "/contacts") return Response.json([{ account_id: 1, room_id: 7001, name: "アリス" }])
        let m = /^\/rooms\/(\d+)\/messages$/.exec(p)
        if (m) {
          gets++
          const id = Number(m[1])
          const all = messages.get(id) ?? []
          const list = all.slice(cursor.get(id) ?? 0)
          cursor.set(id, all.length)
          return list.length ? Response.json(list) : new Response(null, { status: 204 })
        }
        m = /^\/rooms\/(\d+)\/messages\/(\d+)$/.exec(p)
        if (m) return Response.json((messages.get(Number(m[1])) ?? []).find((x) => x.message_id === m![2]))
        m = /^\/rooms\/\d+\/files\/(\d+)$/.exec(p)
        const f = m && files.get(m[1]!)
        if (f) return Response.json({ file_id: Number(m![1]), filename: f.name, filesize: f.data.length, download_url: `${server.url.origin}/dl/${m![1]}` })
        const d = /^\/dl\/(\d+)$/.exec(p)
        const file = d && files.get(d[1]!)
        if (file) return new Response(file.data, { headers: { "Content-Type": TYPES[file.name.split(".").pop()!] ?? "application/octet-stream" } })
        return new Response("not found", { status: 404 })
      }
      let m = /^\/rooms\/(\d+)\/messages$/.exec(p)
      if (req.method === "POST" && m) {
        const body = new URLSearchParams(await req.text()).get("body") ?? ""
        record({ kind: "message", room: Number(m[1]), body })
        return Response.json({ message_id: say(Number(m[1]), BOT.account_id, body) })
      }
      m = /^\/rooms\/(\d+)\/files$/.exec(p)
      if (req.method === "POST" && m) {
        const form = await req.formData()
        const file = form.get("file") as File
        const body = String(form.get("message") ?? "")
        const content = await file.text()
        record({ kind: "file", room: Number(m[1]), body, file: file.name, size: file.size, content: content.slice(0, 100) })
        const fid = String(++seq)
        addFile(fid, file.name, content)
        say(Number(m[1]), BOT.account_id, `${body}[info][title][dtext:file_uploaded][/title][download:${fid}]${file.name} (1 KB)[/download][/info]`)
        return Response.json({ file_id: Number(fid) })
      }
      m = /^\/rooms\/(\d+)\/messages\/(\d+)$/.exec(p)
      if (req.method === "PUT" && m) {
        record({ kind: "edit", room: Number(m[1]), body: new URLSearchParams(await req.text()).get("body") ?? "" })
        return Response.json({ message_id: m[2] })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { server, rooms, sent, say, addFile, join, gets: () => gets }
}
