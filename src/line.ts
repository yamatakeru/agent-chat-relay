// LINE の接続部。Webhook の受信と、Messaging API での送信を受け持つ。

import { createHmac, timingSafeEqual } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"
import { localId } from "./access.ts"
import type { MediaStore } from "./media.ts"
import type { Attachment, Connector, Relay, Verdict } from "./relay.ts"

const SERVICE = "line"
const REPLY_TOKEN_TTL_MS = 50 * 1000 // Reply トークンは 1 分で切れる。余裕を見て 50 秒
const MAX_BUBBLES = 5 // 1 回の送信に入れられるメッセージの数（本文の吹き出しと画像を合わせて）
const MAX_BUBBLE_UNITS = 5000 // 吹き出し 1 つの最大文字数（UTF-16 の単位）
const TRUNCATED_NOTE = "\n\n（長すぎるため、ここから先は省略しました）"
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const TOO_LARGE = "大きすぎるため取得しません（25MB まで）"
const CACHE_CAP = 1000
// 公開 URL に使うホスト名（Webhook の Host ヘッダー）の形。ヘッダーの値をそのまま URL に入れるので絞る
const HOST_RE = /^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/

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

type LineConfig = {
  channelSecret: string
  channelToken: string
  apiBase?: string
  dataApiBase?: string
  /** 返す画像を公開する場所（ADR 0005）。ないと画像を送れない */
  media?: MediaStore
  /** 画像を公開する URL の先頭（例：https://example.com）。なければ、署名を確かめた Webhook が届いたホスト名を使う */
  publicUrl?: string
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
  /** ファイルの元の名前。取得したファイルの拡張子に使う */
  private readonly fileNames = new Map<string, string>()
  private publicBase?: string

  constructor(
    private readonly cfg: LineConfig,
    private readonly relay: Relay,
    private readonly now: () => number = Date.now,
  ) {
    this.api = (cfg.apiBase ?? "https://api.line.me").replace(/\/$/, "")
    this.dataApi = (cfg.dataApiBase ?? cfg.apiBase ?? "https://api-data.line.me").replace(/\/$/, "")
    this.publicBase = cfg.publicUrl?.replace(/\/$/, "")
  }

  /** 署名を確かめ、すぐ 200 を返す。イベントはその後で処理する */
  async handleWebhook(req: Request): Promise<Response> {
    const body = await req.text()
    if (!verifySignature(this.cfg.channelSecret, body, req.headers.get("x-line-signature") ?? "")) {
      return new Response("bad signature", { status: 401 })
    }
    // 署名が合えば、LINE が登録された URL へ送ってきたもの。そのホスト名で画像を公開する（Quick Tunnel は起動ごとに変わる）。
    // LINE は HTTPS の URL しか受け付けないので、トンネル経由（X-Forwarded-Proto: https）のときだけ使う
    const host = req.headers.get("host") ?? ""
    if (!this.cfg.publicUrl && req.headers.get("x-forwarded-proto") === "https" && HOST_RE.test(host)) this.publicBase = `https://${host}`
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
      remember(this.seenEvents, ev.webhookEventId)
    }
    const room = roomOf(ev.source)
    if (!room) return
    if (ev.replyToken && !ev.deliveryContext?.isRedelivery) this.addToken(room, ev.replyToken)
    const sender = ev.source.userId ? `${SERVICE}:${ev.source.userId}` : undefined

    if (ev.type === "join") {
      this.relay.joined(room)
      return
    }
    if (ev.type === "postback") {
      const m = /^perm:(allow|deny):([a-km-z]{5})$/.exec(ev.postback?.data ?? "")
      if (!m || !sender) return
      const verdict = m[1] as Verdict
      const ok = this.relay.answer(sender, m[2]!, verdict)
      await this.notice(room, ok ? (verdict === "allow" ? "✅ 許可しました" : "❌ 拒否しました") : "その依頼は見つからないか、すでに答えが出ています")
      return
    }
    const msg = ev.message
    if (ev.type !== "message" || !msg || !sender) return
    const isDM = ev.source.type === "user"
    if (msg.quoteToken) remember(this.quoteTokens, msg.id, msg.quoteToken)

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
        // 外部の URL にある画像（contentProvider が line 以外）は、LINE から取得できない
        if (msg.contentProvider?.type !== "line") return
        attachments.push({ name: `image-${msg.id}`, type: "image" })
        text = "（画像）"
        break
      case "file":
        if (msg.fileName) remember(this.fileNames, msg.id, msg.fileName)
        attachments.push({ name: msg.fileName ?? `file-${msg.id}`, type: "file", size: msg.fileSize })
        text = "（ファイル）"
        break
      default:
        return
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
    if (result.action === "deliver" && isDM) void this.loading(localId(sender))
  }

  async send(room: string, text: string, opts?: { replyTo?: string; files?: string[] }): Promise<string[]> {
    const files = opts?.files ?? []
    const maxImages = text.trim() ? MAX_BUBBLES - 1 : MAX_BUBBLES
    if (files.length > maxImages) throw new Error(`LINE で一度に送れる画像は、本文があれば ${MAX_BUBBLES - 1} 枚、なければ ${MAX_BUBBLES} 枚までです`)
    // 画像を先に公開する。送れないものがあれば、何も送らずにエラーを返す
    const images = await Promise.all(files.map((f) => this.publish(f)))
    const bubbles = splitBubbles(text, MAX_BUBBLES - images.length)
    if (bubbles.length === 0 && images.length === 0) throw new Error("本文が空です")
    const quoteToken = opts?.replyTo ? this.quoteTokens.get(opts.replyTo) : undefined
    const messages: object[] = bubbles.map((t, i) => ({ type: "text", text: t, ...(i === 0 && quoteToken ? { quoteToken } : {}) }))
    for (const img of images) messages.push({ type: "image", originalContentUrl: img.original, previewImageUrl: img.preview })
    return this.deliver(room, messages)
  }

  private async publish(path: string): Promise<{ original: string; preview: string }> {
    if (!this.cfg.media) throw new Error("画像を送る設定がありません")
    if (!this.publicBase) throw new Error("画像を公開する URL が分からないため、送れません。Webhook が一度届くか、RELAY_PUBLIC_URL を設定すると送れます")
    const { original, preview } = await this.cfg.media.publish(path)
    return { original: `${this.publicBase}/media/${original}`, preview: `${this.publicBase}/media/${preview}` }
  }

  async sendApproval(user: string, text: string, requestId: string): Promise<void> {
    // 承認者の DM へ Push で送る。ボタンでも、yes/no の文字でも答えられる
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
    // 案内は Reply でだけ送り、Push の通数を使わない
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
    if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error(TOO_LARGE)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(TOO_LARGE)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const ext = extname(this.fileNames.get(messageId) ?? "").replace(/[^.a-zA-Z0-9]/g, "") || extension(res.headers.get("content-type") ?? "")
    const path = join(dir, `${this.now()}-${messageId}${ext}`)
    writeFileSync(path, buf, { mode: 0o600 })
    return [path]
  }

  async roomName(room: string): Promise<string | undefined> {
    const id = localId(room)
    if (!id.startsWith("C")) return undefined
    const cached = this.names.get(room)
    if (cached) return cached
    const name = ((await this.get(`/v2/bot/group/${id}/summary`)) as { groupName?: string }).groupName
    if (name) remember(this.names, room, name)
    return name
  }

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
    if (name) remember(this.names, key, name)
    return name
  }

  /** Reply は通数に数えないので優先する。トークンがないか無効なら Push で送る */
  private async deliver(room: string, messages: object[]): Promise<string[]> {
    const token = this.takeToken(room)
    let res: unknown
    if (token) {
      try {
        res = await this.post("/v2/bot/message/reply", { replyToken: token, messages })
      } catch (err) {
        if (!(err instanceof LineApiError && err.invalidReplyToken)) throw err
      }
    }
    res ??= await this.post("/v2/bot/message/push", { to: localId(room), messages }).catch((err) => {
      if (err instanceof LineApiError && err.quotaExceeded) {
        throw new Error("LINE の今月の送信数の上限に達したため、送れませんでした。次に発言があれば、その返事として送れます")
      }
      throw err
    })
    return ((res as { sentMessages?: { id: string; quoteToken?: string }[] }).sentMessages ?? []).map((s) => {
      remember(this.sentIds, s.id)
      if (s.quoteToken) remember(this.quoteTokens, s.id, s.quoteToken)
      return s.id
    })
  }

  private liveTokens(room: string): { token: string; at: number }[] {
    return (this.tokens.get(room) ?? []).filter((t) => this.now() - t.at < REPLY_TOKEN_TTL_MS)
  }

  private addToken(room: string, token: string): void {
    this.tokens.set(room, [...this.liveTokens(room), { token, at: this.now() }])
  }

  private takeToken(room: string): string | undefined {
    const list = this.liveTokens(room)
    const t = list.pop()
    this.tokens.set(room, list)
    return t?.token
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
    if (!res.ok) throw new LineApiError(res.status, apiMessage(raw))
    try {
      return raw ? JSON.parse(raw) : {}
    } catch {
      return {}
    }
  }
}

class LineApiError extends Error {
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

/** X-Line-Signature の値（本文の HMAC-SHA256 を Base64 にしたもの） */
export function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64")
}

export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, body), "base64")
  const given = Buffer.from(signature, "base64")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** 入れて、上限を超えたら最も古いものを捨てる */
function remember(c: Set<string>, key: string): void
function remember(c: Map<string, string>, key: string, value: string): void
function remember(c: Set<string> | Map<string, string>, key: string, value?: string): void {
  if (c instanceof Set) c.add(key)
  else c.set(key, value!)
  if (c.size > CACHE_CAP) c.delete(c.keys().next().value!)
}

function apiMessage(raw: string): string {
  try {
    return (JSON.parse(raw) as { message?: string }).message ?? ""
  } catch {
    return raw.slice(0, 200)
  }
}

function roomOf(s: Source): string | undefined {
  const id = s.type === "group" ? s.groupId : s.type === "room" ? s.roomId : s.userId
  return id ? `${SERVICE}:${id}` : undefined
}

/** 本文から Bot へのメンションを取り除く。LINE の index と length は UTF-16 の単位 */
export function stripSelfMentions(text: string, mentionees: Mentionee[]): string {
  const remove = new Array<boolean>(text.length).fill(false)
  for (const m of mentionees) {
    if (!m.isSelf || m.index < 0 || m.length <= 0 || m.index + m.length > text.length) continue
    remove.fill(true, m.index, m.index + m.length)
  }
  // split("") は UTF-16 の単位で分ける
  return text
    .split("")
    .filter((_, i) => !remove[i])
    .join("")
    .trim()
}

/** 吹き出し max 個（既定は LINE の上限の 5。画像を添えるときは、その分を減らす）に収める。あふれた分は切り、省略したことを書き添える */
export function splitBubbles(text: string, max = MAX_BUBBLES): string[] {
  let rest = text.trim()
  const out: string[] = []
  while (rest.length > 0 && out.length < max) {
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
