// Discord の接続部。Gateway（常時の接続）で受け、REST で送る。どちらも discord.js が受け持つ（ADR 0011）。
// 公式の Claude Code Discord プラグイン（external_plugins/discord）を手本にした。

import { basename, extname } from "node:path"
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Interaction,
  type Message,
  type SendableChannels,
} from "discord.js"
import { localId } from "../core/access.ts"
import { remember, saveDownload, splitText, truncate } from "./common.ts"
import type { Attachment, Capabilities, ChatMessage, Connector, ConnectorDeps, Log, Relay, Verdict } from "../core/relay.ts"

const SERVICE = "discord"
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const LOGIN_TIMEOUT_MS = 30_000

type DiscordConfig = { token: string }

/**
 * ルームと人の ID。チャンネルは c<ID>、スレッドは c<親のチャンネル>/<スレッド>（親の登録を引き継ぐ。ADR 0011）。
 * DM は、LINE・Chatwork と同じく相手の ID（u<ID>）をルームとして扱う
 */
const channelKey = (id: string) => `${SERVICE}:c${id}`
const threadKey = (parentId: string, id: string) => `${SERVICE}:c${parentId}/${id}`
const userKey = (id: string) => `${SERVICE}:u${id}`

/** Bot のトークンがあれば、接続部を作る */
export function discordFromEnv(env: Record<string, string | undefined>, deps: ConnectorDeps): DiscordConnector | undefined {
  const token = env.RELAY_DISCORD_BOT_TOKEN
  return token ? new DiscordConnector({ token }, deps.relay, deps.log) : undefined
}

export class DiscordConnector implements Connector {
  readonly service = SERVICE
  readonly label = "Discord"
  readonly capabilities: Capabilities = {
    // ファイルの上限は、ブーストのないサーバーの既定（10MiB）。ブーストで上がるが、低い方に合わせる
    files: { maxBytes: 10 * 1024 * 1024, maxCount: 10 },
    text: { max: 2000, parts: 10 },
  }
  /** Bot が送った発言の ID。返信をメンションとして扱うのに使う */
  private readonly sentIds = new Set<string>()

  constructor(
    private readonly cfg: DiscordConfig,
    private readonly relay: Relay,
    private readonly log: Log,
    private readonly client: Client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      // DM のチャンネルは、最初は中身のない形で届く。これがないと DM の発言を受け取れない
      partials: [Partials.Channel],
    }),
    private readonly now: () => number = Date.now,
  ) {
    this.client.on(Events.MessageCreate, (msg) => {
      this.handleMessage(msg).catch((err) => this.log.error("Discord の発言の処理に失敗しました", { error: String(err) }))
    })
    this.client.on(Events.InteractionCreate, (i) => {
      this.handleInteraction(i).catch((err) => this.log.error("Discord のボタンの処理に失敗しました", { error: String(err) }))
    })
    this.client.on(Events.Error, (err) => this.log.error("Discord の接続でエラーが起きました", { error: String(err) }))
  }

  /** Gateway につなぎ、使えるようになるまで待つ。止まっている間の発言は届かない（fetch_messages で読める） */
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Discord につながりませんでした（30 秒）")), LOGIN_TIMEOUT_MS)
      this.client.once(Events.ClientReady, () => {
        clearTimeout(timer)
        resolve()
      })
      this.client.login(this.cfg.token).catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
    this.log.info("Discord につながりました", { bot: this.client.user?.tag })
  }

  stop(): void {
    void this.client.destroy()
  }

  async handleMessage(msg: Message): Promise<void> {
    // Bot（自分を含む）と Webhook の発言は受けない。Bot どうしで応答し続けるのを防ぐ
    if (msg.author.bot || msg.webhookId) return
    const me = this.client.user?.id
    if (!me) return
    const isDM = msg.channel.type === ChannelType.DM
    const room = isDM ? userKey(msg.author.id) : roomOf(msg.channel)
    if (!room) return
    const mentioned = isDM || (await this.isMentioned(msg, me))
    const attachments = attachmentsOf(msg)
    let text = renderContent(msg, me, botRoleId(msg))
    if (!text && attachments.length > 0) text = attachments.every((a) => a.type === "image") ? "（画像）" : "（ファイル）"
    const result = this.relay.receive({
      id: msg.id,
      room,
      sender: userKey(msg.author.id),
      senderName: msg.member?.displayName ?? msg.author.displayName,
      text,
      ts: msg.createdTimestamp,
      attachments,
      isDM,
      mentioned,
    })
    // 作業中であることを示す（返事を送るか、10 秒たつと消える）
    if (result.action === "deliver" && "sendTyping" in msg.channel) void msg.channel.sendTyping().catch(() => {})
  }

  /** Bot への @、Bot 専用のロールへの @、Bot の発言への返信。@everyone・@here・ほかのロールは数えない（GLOSSARY） */
  private async isMentioned(msg: Message, me: string): Promise<boolean> {
    if (msg.mentions.users.has(me)) return true
    const role = botRoleId(msg)
    if (role && msg.mentions.roles.has(role)) return true
    const ref = msg.reference?.messageId
    if (!ref) return false
    if (this.sentIds.has(ref) || msg.mentions.repliedUser?.id === me) return true
    // 起動前に送った発言への返信は、元の発言を取って確かめる（消されていれば数えない）
    const original = await msg.fetchReference().catch(() => undefined)
    return original?.author.id === me
  }

  async handleInteraction(i: Interaction): Promise<void> {
    if (!i.isButton()) return
    const m = /^perm:(allow|deny):([a-km-z]{5})$/.exec(i.customId)
    if (!m) return
    const verdict = m[1] as Verdict
    // 許可リストの人でなければ、answer が受け付けない
    if (!this.relay.answer(userKey(i.user.id), m[2]!, verdict)) {
      await i.reply({ content: "その依頼は見つからないか、すでに答えが出ています", flags: MessageFlags.Ephemeral })
      return
    }
    // ボタンを外して結果を書き足す。同じ依頼に二度答えられないようにし、履歴にも残す
    const label = verdict === "allow" ? "✅ 許可しました" : "❌ 拒否しました"
    await i.update({ content: `${i.message.content}\n\n${label}`, components: [] })
  }

  async send(room: string, text: string, opts?: { replyTo?: string; files?: string[] }): Promise<string[]> {
    const ch = await this.channel(room)
    const files = (opts?.files ?? []).map((f) => ({ attachment: f, name: basename(f) }))
    const parts = splitText(text, this.capabilities.text.max, this.capabilities.text.parts)
    if (parts.length === 0 && files.length === 0) throw new Error("本文が空です")
    const ids: string[] = []
    // ファイルと返信の参照は 1 通目に付ける
    for (let i = 0; i < Math.max(parts.length, 1); i++) {
      const sent = await ch.send({
        content: parts[i] || undefined,
        files: i === 0 ? files : [],
        reply: i === 0 && opts?.replyTo ? { messageReference: opts.replyTo, failIfNotExists: false } : undefined,
        // エージェントの本文で、@everyone・@here やロールの通知を鳴らさない
        allowedMentions: { parse: ["users"], repliedUser: true },
      })
      remember(this.sentIds, sent.id)
      ids.push(sent.id)
    }
    return ids
  }

  async sendApproval(user: string, text: string, requestId: string): Promise<void> {
    // ボタンでも、yes/no の文字でも答えられる
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:allow:${requestId}`).setLabel("許可").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${requestId}`).setLabel("拒否").setEmoji("❌").setStyle(ButtonStyle.Danger),
    )
    const ch = await this.channel(user)
    const sent = await ch.send({ content: truncate(text, this.capabilities.text.max), components: [row], allowedMentions: { parse: [] } })
    remember(this.sentIds, sent.id)
  }

  async notice(room: string, text: string): Promise<void> {
    const sent = await (await this.channel(room)).send({ content: text, allowedMentions: { parse: [] } })
    remember(this.sentIds, sent.id)
  }

  async download(room: string, messageId: string, dir: string): Promise<string[]> {
    const msg = await this.message(room, messageId)
    if (msg.attachments.size === 0) throw new Error("この発言には添付がありません")
    const paths: string[] = []
    for (const att of msg.attachments.values()) {
      if (att.size > MAX_DOWNLOAD_BYTES) throw new Error(`大きすぎるため取得しません（25MB まで）: ${att.name}`)
      // 添付は Discord の CDN にある。https の URL だけを取りに行く
      const url = URL.parse(att.url)
      if (url?.protocol !== "https:") throw new Error("添付の URL を取得できませんでした")
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`Discord から取得できませんでした（HTTP ${res.status}）`)
      paths.push(await saveDownload(res, dir, `${this.now()}-${messageId}-${att.id}`, extname(att.name)))
    }
    return paths
  }

  async roomName(room: string): Promise<string | undefined> {
    const m = /^c(\d+)(?:\/(\d+))?$/.exec(localId(room))
    if (!m) return undefined
    const name = (id: string) => {
      const ch = this.client.channels.cache.get(id)
      return ch && "name" in ch && ch.name ? ch.name : undefined
    }
    const parent = name(m[1]!)
    if (!m[2]) return parent && `#${parent}`
    const thread = name(m[2])
    return thread && `#${parent ?? "?"} › ${thread}`
  }

  async react(room: string, messageId: string, emoji: string): Promise<void> {
    await (await this.message(room, messageId)).react(emoji)
  }

  async edit(room: string, messageId: string, text: string): Promise<void> {
    const msg = await this.message(room, messageId)
    if (msg.author.id !== this.client.user?.id) throw new Error("Bot が送った発言だけを編集できます")
    await msg.edit({ content: truncate(text.trim(), this.capabilities.text.max), allowedMentions: { parse: ["users"] } })
  }

  /** Discord の履歴を、古い順に読む（止まっている間の発言も含む） */
  async history(room: string, limit: number): Promise<ChatMessage[]> {
    const ch = await this.channel(room)
    const me = this.client.user?.id ?? ""
    const msgs = await ch.messages.fetch({ limit })
    return [...msgs.values()].reverse().map((m) => ({
      id: m.id,
      room,
      sender: userKey(m.author.id),
      senderName: m.member?.displayName ?? m.author.displayName,
      text: renderContent(m, me, botRoleId(m)),
      ts: m.createdTimestamp,
      attachments: attachmentsOf(m),
      fromMe: m.author.id === me,
    }))
  }

  private async message(room: string, messageId: string): Promise<Message> {
    if (!/^\d+$/.test(messageId)) throw new Error("message_id の形が違います")
    return (await this.channel(room)).messages.fetch(messageId)
  }

  /**
   * ルームの ID を、送れる Discord のチャンネルにする。スレッドは、実際の親が ID の親と同じものだけを許す
   * （登録したチャンネルの ID に、ほかのチャンネルのスレッドを付けて送るのを防ぐ）
   */
  private async channel(room: string): Promise<SendableChannels & { messages: Message["channel"]["messages"] }> {
    const id = localId(room)
    if (!room.startsWith(`${SERVICE}:`)) throw new Error(`Discord の ID の形が違います: ${room}`)
    const dm = /^u(\d+)$/.exec(id)
    if (dm) {
      const user = await this.client.users.fetch(dm[1]!)
      return user.dmChannel ?? (await user.createDM())
    }
    const m = /^c(\d+)(?:\/(\d+))?$/.exec(id)
    if (!m) throw new Error(`Discord の ID の形が違います: ${room}`)
    const ch = await this.client.channels.fetch(m[2] ?? m[1]!).catch(() => null)
    const ok = ch && ch.isSendable() && !ch.isDMBased() && (m[2] ? ch.isThread() && ch.parentId === m[1] : !ch.isThread())
    if (!ok) throw new Error(`Discord のチャンネルが見つからないか、送れません: ${room}`)
    return ch
  }
}

/** ギルドのチャンネルのルーム ID。スレッドは親の ID を付ける */
function roomOf(ch: Message["channel"]): string | undefined {
  if (ch.isThread()) return ch.parentId ? threadKey(ch.parentId, ch.id) : undefined
  return channelKey(ch.id)
}

function botRoleId(msg: Message): string | undefined {
  return msg.guild?.members.me?.roles.botRole?.id
}

function attachmentsOf(msg: Message): Attachment[] {
  return [...msg.attachments.values()].map((a) => ({ name: a.name, type: a.contentType?.startsWith("image/") ? "image" : "file", size: a.size }))
}

/**
 * 本文から Bot へのメンション（@Bot と Bot 専用のロール）を取り除き、ほかのメンションとチャンネルの記法を名前にする。
 * 名前が分からなければ、記法のまま残す
 */
export function renderContent(msg: Pick<Message, "content" | "mentions">, me: string, botRole?: string): string {
  return msg.content
    .replace(new RegExp(`<@!?${me}>${botRole ? `|<@&${botRole}>` : ""}`, "g"), "")
    .replace(/<@!?(\d+)>/g, (s, id: string) => {
      const u = msg.mentions.users.get(id)
      return u ? `@${msg.mentions.members?.get(id)?.displayName ?? u.displayName}` : s
    })
    .replace(/<@&(\d+)>/g, (s, id: string) => {
      const r = msg.mentions.roles.get(id)
      return r ? `@${r.name}` : s
    })
    .replace(/<#(\d+)>/g, (s, id: string) => {
      const c = msg.mentions.channels.get(id)
      return c && "name" in c && c.name ? `#${c.name}` : s
    })
    .trim()
}
