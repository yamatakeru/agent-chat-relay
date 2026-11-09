// Chatwork の接続部。API の定期取得で受け、REST API で送る（ADR 0010）。
// Bot は、専用の Chatwork アカウントの API トークンで発言する。

import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { remember } from "./cache.ts"
import type { Attachment, Connector, Log, Relay } from "../core/relay.ts"

const SERVICE = "chatwork"
const MAX_BODY = 65535 // 本文の上限（文字数）
const TRUNCATED_NOTE = "\n\n（長すぎるため、ここから先は省略しました）"
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 // アップロードできるファイルの上限
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const TOO_LARGE = "大きすぎるため取得しません（25MB まで）"
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"])

type CwRoom = { room_id: number; name: string; type: "my" | "direct" | "group"; last_update_time: number }
type CwMessage = { message_id: string; account: { account_id: number; name: string }; body: string; send_time: number }
type CwFile = { filename: string; filesize: number; download_url?: string }

type ChatworkConfig = {
  apiToken: string
  apiBase?: string
  /** 定期取得の間隔（ミリ秒）。既定は 5 秒 */
  pollMs?: number
}

/** ルームと人の ID。DM（ダイレクトチャット）は、LINE と同じく相手の ID をルームとして扱う */
export const roomKey = (roomId: number) => `${SERVICE}:r${roomId}`
export const userKey = (accountId: number) => `${SERVICE}:u${accountId}`

export class ChatworkConnector implements Connector {
  readonly service = SERVICE
  private readonly api: string
  private me?: { id: number; name: string }
  /** この時刻（Unix 秒）より前の発言は、停止中に届いたものとして記録だけする */
  private startedAt = 0
  private readonly rooms = new Map<number, CwRoom>()
  /** ルームごとの、最後に取得した時点の last_update_time。同じ時刻でもう一度取り、同じ秒に届いた発言を取りこぼさない */
  private readonly fetched = new Map<number, { t: number; done: boolean }>()
  /** DM の相手 → ダイレクトチャットのルーム ID */
  private readonly dmRooms = new Map<number, number>()
  private readonly seen = new Set<string>()
  /** 発言（ルーム ID-メッセージ ID）→ 送り主と本文。返信の記法と、添付の取得に使う */
  private readonly messages = new Map<string, { author: number; body: string }>()
  private pausedUntil = 0
  private timer?: Timer
  private lastError = ""

  constructor(
    private readonly cfg: ChatworkConfig,
    private readonly relay: Relay,
    private readonly log: Log,
    private readonly now: () => number = Date.now,
  ) {
    this.api = (cfg.apiBase ?? "https://api.chatwork.com/v2").replace(/\/$/, "")
  }

  /** Bot のアカウントを確かめ、定期取得を始める。今あるルームの更新時刻を起点にし、それまでの発言は取りに行かない */
  async start(): Promise<void> {
    const me = (await this.call("GET", "/me")) as { account_id: number; name: string }
    this.me = { id: me.account_id, name: me.name }
    this.startedAt = Math.floor(this.now() / 1000)
    for (const r of await this.listRooms()) this.fetched.set(r.room_id, { t: r.last_update_time, done: true })
    this.schedule()
  }

  stop(): void {
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      this.poll()
        .then(() => (this.lastError = ""))
        .catch((err) => {
          // 同じ失敗を 5 秒ごとに書かない
          const msg = String(err)
          if (msg !== this.lastError) this.log.error("Chatwork から取得できませんでした", { error: msg })
          this.lastError = msg
        })
        .finally(() => {
          if (this.timer) this.schedule()
        })
    }, this.cfg.pollMs ?? 5000)
  }

  /** ルーム一覧で更新のあったルームだけ、前回からの差分を取る */
  async poll(): Promise<void> {
    if (this.now() < this.pausedUntil) return
    for (const r of await this.listRooms()) {
      if (r.type === "my") continue
      const prev = this.fetched.get(r.room_id)
      // 起動後に現れたグループチャットは、Bot が追加されたもの（LINE の join に当たる。Chatwork にはその通知がない）
      if (!prev && r.type === "group") this.relay.joined(roomKey(r.room_id))
      if (prev && r.last_update_time <= prev.t && prev.done) continue
      const msgs = ((await this.call("GET", `/rooms/${r.room_id}/messages?force=0`)) as CwMessage[] | null) ?? []
      this.fetched.set(r.room_id, { t: r.last_update_time, done: prev?.t === r.last_update_time })
      for (const m of msgs.sort((a, b) => a.send_time - b.send_time)) this.handle(r, m)
    }
  }

  handle(r: CwRoom, m: CwMessage): void {
    const key = `${r.room_id}-${m.message_id}`
    if (this.seen.has(key)) return
    remember(this.seen, key)
    const author = m.account.account_id
    remember(this.messages, key, { author, body: m.body })
    if (!this.me || author === this.me.id) return
    const isDM = r.type === "direct"
    if (isDM) this.dmRooms.set(author, r.room_id)
    const parsed = parseBody(m.body, this.me)
    this.relay.receive({
      id: m.message_id,
      room: isDM ? userKey(author) : roomKey(r.room_id),
      sender: userKey(author),
      senderName: m.account.name,
      text: parsed.text,
      ts: m.send_time * 1000,
      attachments: parsed.attachments,
      isDM,
      mentioned: isDM || parsed.mentioned,
      stale: m.send_time < this.startedAt,
    })
  }

  async send(room: string, text: string, opts?: { replyTo?: string; files?: string[] }): Promise<string[]> {
    const rid = await this.roomId(room)
    const files = opts?.files ?? []
    // 送れないファイルがあれば、何も送らずにエラーを返す
    for (const f of files) {
      if (statSync(f).size > MAX_UPLOAD_BYTES) throw new Error(`Chatwork に送れるファイルは 5MB までです: ${basename(f)}`)
    }
    let body = fit(text.trim())
    const author = opts?.replyTo ? this.messages.get(`${rid}-${opts.replyTo}`)?.author : undefined
    if (body && author !== undefined) body = `[rp aid=${author} to=${rid}-${opts!.replyTo}]\n${body}`
    if (!body && files.length === 0) throw new Error("本文が空です")
    if (files.length === 0) return [await this.post(rid, body)]
    // 本文は 1 つ目のファイルに添える。ファイルの投稿は、メッセージ ID を返さない
    for (const [i, f] of files.entries()) {
      const form = new FormData()
      form.append("file", Bun.file(f), basename(f))
      if (i === 0 && body) form.append("message", body)
      await this.call("POST", `/rooms/${rid}/files`, form, 60_000)
    }
    return []
  }

  async sendApproval(user: string, text: string, _requestId: string): Promise<void> {
    // ボタンはないので、yes/no の文字で答えてもらう
    await this.post(await this.roomId(user), text)
  }

  async notice(room: string, text: string): Promise<void> {
    await this.post(await this.roomId(room), text)
  }

  async download(room: string, messageId: string, dir: string): Promise<string[]> {
    if (!/^\d+$/.test(messageId)) throw new Error("message_id の形が違います")
    const rid = await this.roomId(room)
    const body =
      this.messages.get(`${rid}-${messageId}`)?.body ?? ((await this.call("GET", `/rooms/${rid}/messages/${messageId}`)) as CwMessage).body
    const ids = [...body.matchAll(/\[download:(\d+)\]/g)].map((m) => m[1]!)
    if (ids.length === 0) throw new Error("この発言には添付がありません")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const paths: string[] = []
    for (const fid of new Set(ids)) {
      const file = (await this.call("GET", `/rooms/${rid}/files/${fid}?create_download_url=1`)) as CwFile
      if (file.filesize > MAX_DOWNLOAD_BYTES) throw new Error(TOO_LARGE)
      // モックの API（http）では、同じホストの URL を許す
      const url = URL.parse(file.download_url ?? "")
      if (!url || (url.protocol !== "https:" && url.origin !== URL.parse(this.api)?.origin)) throw new Error("ダウンロードの URL を取得できませんでした")
      // 取得用の URL は 30 秒で切れる。API トークンは付けない（別のホストへ渡さない）
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`Chatwork から取得できませんでした（HTTP ${res.status}）`)
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(TOO_LARGE)
      const ext = extname(file.filename).replace(/[^.a-zA-Z0-9]/g, "")
      const path = join(dir, `${this.now()}-${messageId}-${fid}${ext}`)
      writeFileSync(path, buf, { mode: 0o600 })
      paths.push(path)
    }
    return paths
  }

  async roomName(room: string): Promise<string | undefined> {
    const m = /^chatwork:r(\d+)$/.exec(room)
    return m ? this.rooms.get(Number(m[1]))?.name : undefined
  }

  async edit(room: string, messageId: string, text: string): Promise<void> {
    if (!/^\d+$/.test(messageId)) throw new Error("message_id の形が違います")
    const rid = await this.roomId(room)
    await this.call("PUT", `/rooms/${rid}/messages/${messageId}`, new URLSearchParams({ body: fit(text.trim()) }))
  }

  private async post(rid: number, body: string): Promise<string> {
    const res = (await this.call("POST", `/rooms/${rid}/messages`, new URLSearchParams({ body }))) as { message_id: string }
    return res.message_id
  }

  private async listRooms(): Promise<CwRoom[]> {
    const list = ((await this.call("GET", "/rooms")) as CwRoom[] | null) ?? []
    for (const r of list) this.rooms.set(r.room_id, r)
    return list
  }

  /** ルームの ID を、Chatwork のルーム ID にする。DM の相手なら、コンタクトからダイレクトチャットを探す */
  private async roomId(id: string): Promise<number> {
    const m = /^chatwork:([ru])(\d+)$/.exec(id)
    if (!m) throw new Error(`Chatwork の ID の形が違います: ${id}`)
    const n = Number(m[2])
    if (m[1] === "r") return n
    let rid = this.dmRooms.get(n)
    if (rid === undefined) {
      const contacts = ((await this.call("GET", "/contacts")) as { account_id: number; room_id: number }[] | null) ?? []
      for (const c of contacts) this.dmRooms.set(c.account_id, c.room_id)
      rid = this.dmRooms.get(n)
    }
    if (rid === undefined) throw new Error("この人とのダイレクトチャットが見つかりません（Bot のコンタクトではありません）")
    return rid
  }

  private async call(method: string, path: string, body?: URLSearchParams | FormData, timeoutMs = 15_000): Promise<unknown> {
    if (this.now() < this.pausedUntil) throw new Error(`Chatwork の API の回数制限に達しています。${Math.ceil((this.pausedUntil - this.now()) / 1000)} 秒後に使えます`)
    const res = await fetch(`${this.api}${path}`, { method, headers: { "x-chatworktoken": this.cfg.apiToken }, body, signal: AbortSignal.timeout(timeoutMs) })
    if (res.status === 204) return null
    const raw = await res.text()
    if (!res.ok) {
      const msg = apiErrors(raw)
      if (res.status === 429) {
        // ルームごとの投稿の制限（10 秒に 10 回）なら、そのルームにだけかかる。全体の制限なら、戻るまで止める
        if (/per room/i.test(msg)) throw new Error("このルームへの投稿が多すぎます。10 秒ほど待ってから送ってください")
        const reset = Number(res.headers.get("x-ratelimit-reset"))
        this.pausedUntil = reset > 0 ? reset * 1000 : this.now() + 60_000
        throw new Error("Chatwork の API の回数制限（5 分に 300 回）に達しました")
      }
      throw new Error(`Chatwork API: HTTP ${res.status}: ${msg}`)
    }
    try {
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }
}

/** 本文から、Bot へのメンションと返信の記法を取り除き、添付を取り出す。ほかの記法はそのまま渡す */
export function parseBody(body: string, me: { id: number; name: string }): { text: string; attachments: Attachment[]; mentioned: boolean } {
  // Chatwork の画面で To や返信を付けると、記法の後ろに「名前さん」が入る
  const self = new RegExp(`\\[(?:To:${me.id}|rp aid=${me.id} to=\\d+-\\d+)\\][ \\t]*(?:${escapeRegExp(me.name)}(?:さん)?)?`, "g")
  const attachments: Attachment[] = []
  let text = body.replace(self, "")
  const mentioned = text !== body
  text = text.replace(/\[download:\d+\]([\s\S]*?)\[\/download\]/g, (_, label: string) => {
    // 表示は「ファイル名 (12.34 KB)」
    const name = label.replace(/\s*\([\d.,]+\s*[KMG]?B\)\s*$/i, "").trim() || "file"
    attachments.push({ name, type: IMAGE_EXT.has(extname(name).toLowerCase()) ? "image" : "file" })
    return ""
  })
  text = text
    .replace(/\[preview [^\]]*\]/g, "")
    .replace(/\[info\]\s*\[title\]\[dtext:file_uploaded\]\[\/title\]\s*\[\/info\]/g, "")
    .trim()
  if (!text && attachments.length > 0) text = attachments.every((a) => a.type === "image") ? "（画像）" : "（ファイル）"
  return { text, attachments, mentioned }
}

function fit(text: string): string {
  return text.length <= MAX_BODY ? text : text.slice(0, MAX_BODY - TRUNCATED_NOTE.length) + TRUNCATED_NOTE
}

function apiErrors(raw: string): string {
  try {
    return ((JSON.parse(raw) as { errors?: string[] }).errors ?? []).join(", ")
  } catch {
    return raw.slice(0, 200)
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
