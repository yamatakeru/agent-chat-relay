// LINE の接続部。Webhook の受信と、Messaging API での送信を受け持つ。
// 仕様の判断は old/docs/line-adapter.md を引き継ぐ（Reply トークンを優先する送信、吹き出しの分割など）。

import { createHmac, timingSafeEqual } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"
import type { Attachment, Connector, Relay } from "./relay.ts"

const SERVICE = "line"
const REPLY_TOKEN_TTL_MS = 50 * 1000 // Reply トークンは 1 分で切れる。余裕を見て 50 秒
const MAX_BUBBLES = 5 // 1 回の送信に入れられる吹き出しの数
const MAX_BUBBLE_UNITS = 5000 // 吹き出し 1 つの最大文字数（UTF-16 の単位）
const TRUNCATED_NOTE = "\n\n（長すぎるため、ここから先は省略しました）"
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const SENT_IDS_CAP = 200

type Source = { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string }
type Mentionee = { index: number; length: number; isSelf?: boolean }
type LineEvent = {
  type: string
  webhookEventId?: string
  timestamp: number
  replyToken?: string
  source: Source
  deliveryContext?: { isRedelivery?: boolean }
  message?: {
    id: string
    type: string
    text?: string
    quoteToken?: string
    quotedMessageId?: string
    mention?: { mentionees: Mentionee[] }
    fileName?: string
    fileSize?: number
    contentProvider?: { type: string }
  }
  postback?: { data: string }
}

export type LineConfig = {
  channelSecret: string
  channelToken: string
  apiBase?: string
  dataApiBase?: string
}

export class LineConnector implements Connector {
  readonly service = SERVICE
  private readonly api: string
  private readonly dataApi: string
  private readonly tokens = new Map<string, { token: string; at: number }[]>()
  private readonly quoteTokens = new Map<string, string>()
  private readonly sentIds = new Set<string>()
  private readonly seenEvents = new Set<string>()
  private readonly names = new Map<string, string>()
  /** ファイルの発言の元の名前（拡張子を保つため） */
  private readonly fileNames = new Map<string, string>()

  constructor(
    private readonly cfg: LineConfig,
    private readonly relay: Relay,
    private readonly now: () => number = Date.now,
  ) {
    this.api = (cfg.apiBase ?? "https://api.line.me").replace(/\/$/, "")
    this.dataApi = (cfg.dataApiBase ?? cfg.apiBase ?? "https://api-data.line.me").replace(/\/$/, "")
  }

  /** Webhook の受け口。署名を確かめ、すぐ 200 を返して、イベントは後で処理する */
  async handleWebhook(req: Request): Promise<Response> {
    const body = await req.text()
    if (!verifySignature(this.cfg.channelSecret, body, req.headers.get("x-line-signature") ?? "")) {
      return new Response("bad signature", { status: 401 })
    }
    let events: LineEvent[]
    try {
      events = (JSON.parse(body) as { events?: LineEvent[] }).events ?? []
    } catch {
      return new Response("bad request", { status: 400 })
    }
    queueMicrotask(() => {
      for (const ev of events) {
        this.handleEvent(ev).catch((err) => console.error("line: イベントの処理に失敗しました", err))
      }
    })
    return new Response("ok")
  }

  async handleEvent(ev: LineEvent): Promise<void> {
    if (ev.webhookEventId) {
      if (this.seenEvents.has(ev.webhookEventId)) return
      this.seenEvents.add(ev.webhookEventId)
      if (this.seenEvents.size > 1000) this.seenEvents.delete(this.seenEvents.values().next().value!)
    }
    const room = roomOf(ev.source)
    if (!room) return
    if (ev.replyToken && !ev.deliveryContext?.isRedelivery) this.addToken(room, ev.replyToken)

    switch (ev.type) {
      case "join":
        this.relay.joined(room)
        return
      case "postback": {
        const m = /^perm:(allow|deny):([a-km-z]{5})$/.exec(ev.postback?.data ?? "")
        const sender = ev.source.userId ? `${SERVICE}:${ev.source.userId}` : undefined
        if (m && sender) {
          const ok = this.relay.answer(sender, m[2]!, m[1] === "allow" ? "allow" : "deny")
          await this.notice(room, ok ? (m[1] === "allow" ? "✅ 許可しました" : "❌ 拒否しました") : "その依頼は見つからないか、すでに答えが出ています")
        }
        return
      }
      case "message":
        break
      default:
        return
    }
    const msg = ev.message
    if (!msg || !ev.source.userId) return
    const sender = `${SERVICE}:${ev.source.userId}`
    const isDM = ev.source.type === "user"
    if (msg.quoteToken) this.rememberQuoteToken(msg.id, msg.quoteToken)

    let text = ""
    const attachments: Attachment[] = []
    let mentioned = isDM
    switch (msg.type) {
      case "text": {
        const mentionees = msg.mention?.mentionees ?? []
        mentioned ||= mentionees.some((m) => m.isSelf) || (msg.quotedMessageId !== undefined && this.sentIds.has(msg.quotedMessageId))
        text = stripSelfMentions(msg.text ?? "", mentionees)
        break
      }
      case "image":
        // 外部の URL にある画像（contentProvider が line 以外）は取得できない
        if (msg.contentProvider?.type !== "line") return
        attachments.push({ name: `image-${msg.id}`, type: "image" })
        text = "（画像）"
        break
      case "file":
        if (msg.fileName) this.fileNames.set(msg.id, msg.fileName)
        attachments.push({ name: msg.fileName ?? `file-${msg.id}`, type: "file", size: msg.fileSize })
        text = "（ファイル）"
        break
      default:
        return // 音声・動画・スタンプなどは扱わない
    }
    const result = this.relay.receive({
      id: msg.id,
      room,
      sender,
      senderName: await this.memberName(ev.source).catch(() => undefined),
      text,
      ts: ev.timestamp,
      attachments,
      isDM,
      mentioned,
    })
    if (result.action === "deliver" && isDM) void this.loading(ev.source.userId)
  }

  async send(room: string, text: string, opts?: { replyTo?: string }): Promise<string[]> {
    const bubbles = splitBubbles(text)
    if (bubbles.length === 0) throw new Error("本文が空です")
    const quoteToken = opts?.replyTo ? this.quoteTokens.get(opts.replyTo) : undefined
    const messages = bubbles.map((t, i) => ({ type: "text", text: t, ...(i === 0 && quoteToken ? { quoteToken } : {}) }))
    return this.deliver(room, messages)
  }

  async sendApproval(user: string, text: string, requestId: string): Promise<void> {
    // 承認者の DM へ送る（Push。承認者 1 人につき 1 通）。ボタンでも文字でも答えられる
    const items = [
      { label: "許可", data: `perm:allow:${requestId}` },
      { label: "拒否", data: `perm:deny:${requestId}` },
    ].map((b) => ({ type: "action", action: { type: "postback", label: b.label, data: b.data, displayText: b.label } }))
    await this.post("/v2/bot/message/push", {
      to: localId(user),
      messages: [{ type: "text", text: splitBubbles(text)[0], quickReply: { items } }],
    })
  }

  async notice(room: string, text: string): Promise<void> {
    // 案内は Reply トークンがあるときだけ送る（Push の通数を使わない）
    const token = this.takeToken(room)
    if (!token) return
    await this.post("/v2/bot/message/reply", { replyToken: token, messages: [{ type: "text", text }] })
  }

  async download(_room: string, messageId: string, dir: string): Promise<string[]> {
    if (!/^\d+$/.test(messageId)) throw new Error("message_id の形が違います")
    const res = await fetch(`${this.dataApi}/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${this.cfg.channelToken}` },
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`LINE から取得できませんでした（HTTP ${res.status}）`)
    const length = Number(res.headers.get("content-length") ?? 0)
    if (length > MAX_DOWNLOAD_BYTES) throw new Error("大きすぎるため取得しません（25MB まで）")
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error("大きすぎるため取得しません（25MB まで）")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const ext = extname(this.fileNames.get(messageId) ?? "").replace(/[^.a-zA-Z0-9]/g, "") || extension(res.headers.get("content-type") ?? "")
    const path = join(dir, `${this.now()}-${messageId}${ext}`)
    writeFileSync(path, buf, { mode: 0o600 })
    return [path]
  }

  async roomName(room: string): Promise<string | undefined> {
    const id = localId(room)
    if (!/^C/.test(id)) return undefined
    const cached = this.names.get(room)
    if (cached) return cached
    const res = await this.get(`/v2/bot/group/${id}/summary`)
    const name = (res as { groupName?: string }).groupName
    if (name) this.names.set(room, name)
    return name
  }

  // ---- 内部 ----

  private async memberName(source: Source): Promise<string | undefined> {
    const user = source.userId
    if (!user) return undefined
    const key = `${source.groupId ?? source.roomId ?? ""}/${user}`
    const cached = this.names.get(key)
    if (cached) return cached
    const path = source.groupId
      ? `/v2/bot/group/${source.groupId}/member/${user}`
      : source.roomId
        ? `/v2/bot/room/${source.roomId}/member/${user}`
        : `/v2/bot/profile/${user}`
    const name = ((await this.get(path)) as { displayName?: string }).displayName
    if (name) this.names.set(key, name)
    return name
  }

  /** Reply トークンがあれば Reply、なければ Push で送る */
  private async deliver(room: string, messages: object[]): Promise<string[]> {
    const token = this.takeToken(room)
    let res: unknown
    if (token) {
      try {
        res = await this.post("/v2/bot/message/reply", { replyToken: token, messages })
      } catch (err) {
        if (!(err instanceof LineApiError && err.invalidReplyToken)) throw err
        res = undefined
      }
    }
    if (res === undefined) {
      try {
        res = await this.post("/v2/bot/message/push", { to: localId(room), messages })
      } catch (err) {
        if (err instanceof LineApiError && err.quotaExceeded) {
          throw new Error("LINE の今月の送信数の上限に達したため、送れませんでした。次に発言があれば、その返事として送れます")
        }
        throw err
      }
    }
    const ids = ((res as { sentMessages?: { id: string; quoteToken?: string }[] }).sentMessages ?? []).map((s) => {
      this.noteSent(s.id)
      if (s.quoteToken) this.rememberQuoteToken(s.id, s.quoteToken)
      return s.id
    })
    return ids
  }

  private addToken(room: string, token: string): void {
    const list = (this.tokens.get(room) ?? []).filter((t) => this.now() - t.at < REPLY_TOKEN_TTL_MS)
    list.push({ token, at: this.now() })
    this.tokens.set(room, list)
  }

  private takeToken(room: string): string | undefined {
    const list = (this.tokens.get(room) ?? []).filter((t) => this.now() - t.at < REPLY_TOKEN_TTL_MS)
    const t = list.pop() // いちばん新しいもの
    this.tokens.set(room, list)
    return t?.token
  }

  private noteSent(id: string): void {
    this.sentIds.add(id)
    if (this.sentIds.size > SENT_IDS_CAP) this.sentIds.delete(this.sentIds.values().next().value!)
  }

  private rememberQuoteToken(id: string, token: string): void {
    this.quoteTokens.set(id, token)
    if (this.quoteTokens.size > 1000) this.quoteTokens.delete(this.quoteTokens.keys().next().value!)
  }

  private async loading(userId: string): Promise<void> {
    await this.post("/v2/bot/chat/loading/start", { chatId: userId, loadingSeconds: 60 }).catch(() => {})
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    return this.call(`${this.api}${path}`, { method: "POST", body: JSON.stringify(payload) })
  }

  private async get(path: string): Promise<unknown> {
    return this.call(`${this.api}${path}`, { method: "GET" })
  }

  private async call(url: string, init: RequestInit): Promise<unknown> {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.cfg.channelToken}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15_000),
    })
    const raw = await res.text()
    if (!res.ok) {
      throw new LineApiError(res.status, apiMessage(raw))
    }
    try {
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  }
}

export class LineApiError extends Error {
  constructor(
    readonly status: number,
    readonly apiMessage: string,
  ) {
    super(`LINE API: HTTP ${status}: ${apiMessage}`)
  }
  get quotaExceeded(): boolean {
    return this.status === 429 && /monthly limit/i.test(this.apiMessage)
  }
  get invalidReplyToken(): boolean {
    return this.status === 400 && /reply token/i.test(this.apiMessage)
  }
}

export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest()
  let given: Buffer
  try {
    given = Buffer.from(signature, "base64")
  } catch {
    return false
  }
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function apiMessage(raw: string): string {
  try {
    return (JSON.parse(raw) as { message?: string }).message ?? ""
  } catch {
    return raw.slice(0, 200) // JSON でない応答は、先頭だけを残す
  }
}

function roomOf(s: Source): string | undefined {
  const id = s.type === "group" ? s.groupId : s.type === "room" ? s.roomId : s.userId
  return id ? `${SERVICE}:${id}` : undefined
}

function localId(id: string): string {
  return id.slice(id.indexOf(":") + 1)
}

/** 本文から Bot へのメンションを取り除く。LINE の index と length は UTF-16 の単位 */
export function stripSelfMentions(text: string, mentionees: Mentionee[]): string {
  const units = Array.from({ length: text.length }, (_, i) => text.charCodeAt(i))
  const remove = new Array<boolean>(units.length).fill(false)
  for (const m of mentionees) {
    if (!m.isSelf || m.index < 0 || m.length <= 0 || m.index + m.length > units.length) continue
    for (let i = m.index; i < m.index + m.length; i++) remove[i] = true
  }
  return String.fromCharCode(...units.filter((_, i) => !remove[i])).trim()
}

/** 本文を最大 5 つの吹き出しに分ける。入りきらない分は切り、省略したことを書き添える */
export function splitBubbles(text: string): string[] {
  let rest = text.trim()
  const out: string[] = []
  while (rest.length > 0 && out.length < MAX_BUBBLES) {
    const n = fitUnits(rest, MAX_BUBBLE_UNITS)
    out.push(rest.slice(0, n))
    rest = rest.slice(n)
  }
  if (rest.length > 0) {
    const last = out[out.length - 1]!
    out[out.length - 1] = last.slice(0, fitUnits(last, MAX_BUBBLE_UNITS - TRUNCATED_NOTE.length)) + TRUNCATED_NOTE
  }
  return out
}

/** UTF-16 で limit 単位に収まる長さ。サロゲートペアの途中では切らない */
function fitUnits(s: string, limit: number): number {
  if (s.length <= limit) return s.length
  const code = s.charCodeAt(limit - 1)
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
}

function extension(contentType: string): string {
  const t = contentType.split(";")[0]!.trim()
  return { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "application/pdf": ".pdf", "text/plain": ".txt" }[t] ?? ".bin"
}
