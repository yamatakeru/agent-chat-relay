// Discord の接続部。Gateway（常時の接続）で受け、REST で送る。どちらも discord.js が受け持つ（ADR 0011）。
// 公式の Claude Code Discord プラグイン（external_plugins/discord）を手本にした。

import { once } from "node:events"
import { basename, extname } from "node:path"
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Options,
  Partials,
  type Interaction,
  type Message,
  type MessageMentionOptions,
  type SendableChannels,
} from "discord.js"
import { localId } from "../core/access.ts"
import { assertNumericId, attachmentOnlyText, parsePermissionData, permissionData, saveDownload, splitText, truncate, verdictText } from "./common.ts"
import { ApiClient } from "./http.ts"
import type { Attachment, Capabilities, ChatMessage, Connector, ConnectorDeps, Log, Relay } from "../core/relay.ts"

const SERVICE = "discord"
const LOGIN_TIMEOUT_SEC = 30
// エージェントの本文で、@everyone・@here やロールの通知を鳴らさない（プロンプトインジェクションで大勢に鳴らされるのを防ぐ）
const AGENT_MENTIONS: MessageMentionOptions = { parse: ["users"], repliedUser: true }
// 中継が決めた文面（承認の依頼、コード）では、誰の通知も鳴らさない
const NO_MENTIONS: MessageMentionOptions = { parse: [] }

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
  // スレッドは c<親>/<スレッド>。送るときに、実際の親を確かめる（channel()）
  readonly nestedRooms = true
  /** 添付の取得用。添付は Discord の CDN にあり、認証は要らない */
  private readonly cdn = new ApiClient({ label: "Discord", base: "https://cdn.discordapp.com", auth: () => ({}), errorMessage: (raw) => raw.slice(0, 200) })

  constructor(
    private readonly cfg: DiscordConfig,
    private readonly relay: Relay,
    private readonly log: Log,
    private readonly client: Client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
      // DM のチャンネルは、最初は中身のない形で届く。これがないと DM の発言を受け取れない
      partials: [Partials.Channel],
      // 常駐するので、覚えておく発言を絞る（既定はチャンネルごとに 200 件で、増え続ける）
      makeCache: Options.cacheWithLimits({ ...Options.DefaultMakeCacheSettings, MessageManager: 50 }),
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
    const signal = AbortSignal.timeout(LOGIN_TIMEOUT_SEC * 1000)
    try {
      await Promise.all([once(this.client, Events.ClientReady, { signal }), this.client.login(this.cfg.token)])
    } catch (err) {
      throw signal.aborted ? new Error(`Discord につながりませんでした（${LOGIN_TIMEOUT_SEC} 秒）`) : err
    }
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
    const isDM = msg.channel.isDMBased()
    const room = isDM ? userKey(msg.author.id) : roomOf(msg.channel)
    if (!room) return
    const role = botRoleId(msg)
    const attachments = attachmentsOf(msg)
    const result = this.relay.receive({
      id: msg.id,
      room,
      sender: userKey(msg.author.id),
      senderName: msg.member?.displayName ?? msg.author.displayName,
      text: renderContent(msg, me, role) || attachmentOnlyText(attachments),
      ts: msg.createdTimestamp,
      attachments,
      isDM,
      mentioned: isDM || isMentioned(msg, me, role),
    })
    // 作業中であることを示す（返事を送るか、10 秒たつと消える）
    if (result.action === "deliver" && "sendTyping" in msg.channel) void msg.channel.sendTyping().catch(() => {})
  }

  async handleInteraction(i: Interaction): Promise<void> {
    if (!i.isButton()) return
    const p = parsePermissionData(i.customId)
    if (!p) return
    // 許可リストの人でなければ、answer が受け付けない
    if (!this.relay.answer(userKey(i.user.id), p.id, p.verdict)) {
      await i.reply({ content: verdictText(false, p.verdict), flags: MessageFlags.Ephemeral })
      return
    }
    // ボタンを外して結果を書き足す。同じ依頼に二度答えられないようにし、履歴にも残す。上限を超えないよう、元の文面を詰める
    const suffix = `\n\n${verdictText(true, p.verdict)}`
    await i.update({ content: truncate(i.message.content, this.capabilities.text.max - suffix.length) + suffix, components: [] })
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
        allowedMentions: AGENT_MENTIONS,
      })
      ids.push(sent.id)
    }
    return ids
  }

  async sendApproval(user: string, text: string, requestId: string): Promise<void> {
    // ボタンでも、yes/no の文字でも答えられる
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(permissionData("allow", requestId)).setLabel("許可").setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(permissionData("deny", requestId)).setLabel("拒否").setEmoji("❌").setStyle(ButtonStyle.Danger),
    )
    const ch = await this.channel(user)
    await ch.send({ content: truncate(text, this.capabilities.text.max), components: [row], allowedMentions: NO_MENTIONS })
  }

  async notice(room: string, text: string): Promise<void> {
    await (await this.channel(room)).send({ content: text, allowedMentions: NO_MENTIONS })
  }

  async download(room: string, messageId: string, dir: string): Promise<string[]> {
    const msg = await this.message(room, messageId)
    if (msg.attachments.size === 0) throw new Error("この発言には添付がありません")
    const paths: string[] = []
    for (const att of msg.attachments.values()) {
      const res = await this.cdn.download(att.url, "none")
      paths.push(await saveDownload(res, dir, `${this.now()}-${messageId}-${att.id}`, extname(att.name)))
    }
    return paths
  }

  async roomName(room: string): Promise<string | undefined> {
    const r = parseRoom(room)
    if (!r || r.kind === "dm") return undefined
    const name = (id: string) => {
      const ch = this.client.channels.cache.get(id)
      return ch && "name" in ch && ch.name ? ch.name : undefined
    }
    const parent = name(r.channel)
    if (!r.thread) return parent && `#${parent}`
    const thread = name(r.thread)
    return thread && `#${parent ?? "?"} › ${thread}`
  }

  async react(room: string, messageId: string, emoji: string): Promise<void> {
    await (await this.message(room, messageId)).react(emoji)
  }

  async edit(room: string, messageId: string, text: string): Promise<void> {
    const msg = await this.message(room, messageId)
    if (msg.author.id !== this.client.user?.id) throw new Error("Bot が送った発言だけを編集できます")
    await msg.edit({ content: truncate(text.trim(), this.capabilities.text.max), allowedMentions: AGENT_MENTIONS })
  }

  /** Discord の履歴を、古い順に読む（止まっている間の発言も含む） */
  async history(room: string, limit: number): Promise<ChatMessage[]> {
    const ch = await this.channel(room)
    const me = this.client.user?.id ?? ""
    const msgs = await ch.messages.fetch({ limit })
    const role = "guild" in ch ? ch.guild.members.me?.roles.botRole?.id : undefined
    return [...msgs.values()].reverse().map((m) => ({
      id: m.id,
      room,
      sender: userKey(m.author.id),
      senderName: m.member?.displayName ?? m.author.displayName,
      text: renderContent(m, me, role),
      ts: m.createdTimestamp,
      attachments: attachmentsOf(m),
      fromMe: m.author.id === me,
    }))
  }

  private async message(room: string, messageId: string): Promise<Message> {
    assertNumericId(messageId)
    return (await this.channel(room)).messages.fetch(messageId)
  }

  /**
   * ルームの ID を、送れる Discord のチャンネルにする。スレッドは、実際の親が ID の親と同じものだけを許す
   * （登録したチャンネルの ID に、ほかのチャンネルのスレッドを付けて送るのを防ぐ）
   */
  private async channel(room: string): Promise<SendableChannels & { messages: Message["channel"]["messages"] }> {
    const r = parseRoom(room)
    if (!r) throw new Error(`Discord の ID の形が違います: ${room}`)
    if (r.kind === "dm") {
      const user = await this.client.users.fetch(r.user)
      return user.dmChannel ?? (await user.createDM())
    }
    const ch = await this.client.channels.fetch(r.thread ?? r.channel).catch(() => null)
    const ok = ch && ch.isSendable() && !ch.isDMBased() && (r.thread ? ch.isThread() && ch.parentId === r.channel : !ch.isThread())
    if (!ok) throw new Error(`Discord のチャンネルが見つからないか、送れません: ${room}`)
    return ch
  }
}

/** ルームの ID を読む。channelKey・threadKey・userKey の逆 */
function parseRoom(room: string): { kind: "dm"; user: string } | { kind: "channel"; channel: string; thread?: string } | undefined {
  if (!room.startsWith(`${SERVICE}:`)) return undefined
  const id = localId(room)
  const dm = /^u(\d+)$/.exec(id)
  if (dm) return { kind: "dm", user: dm[1]! }
  const m = /^c(\d+)(?:\/(\d+))?$/.exec(id)
  return m ? { kind: "channel", channel: m[1]!, thread: m[2] } : undefined
}

/** ギルドのチャンネルのルーム ID。スレッドは親の ID を付ける */
function roomOf(ch: Message["channel"]): string | undefined {
  if (ch.isThread()) return ch.parentId ? threadKey(ch.parentId, ch.id) : undefined
  return channelKey(ch.id)
}

/**
 * Bot への @、Bot 専用のロールへの @、Bot の発言への返信。@everyone・@here・ほかのロールは数えない（GLOSSARY）。
 * repliedUser は、返信の通知を鳴らしたかによらず、返信先の発言の送り主になる（discord.js の Message._patch）
 */
function isMentioned(msg: Message, me: string, botRole: string | undefined): boolean {
  return msg.mentions.users.has(me) || (botRole !== undefined && msg.mentions.roles.has(botRole)) || msg.mentions.repliedUser?.id === me
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
    .replace(/<@!?(\d+)>/g, (s, id: string) => {
      if (id === me) return ""
      const u = msg.mentions.users.get(id)
      return u ? `@${msg.mentions.members?.get(id)?.displayName ?? u.displayName}` : s
    })
    .replace(/<@&(\d+)>/g, (s, id: string) => {
      if (id === botRole) return ""
      const r = msg.mentions.roles.get(id)
      return r ? `@${r.name}` : s
    })
    .replace(/<#(\d+)>/g, (s, id: string) => {
      const c = msg.mentions.channels.get(id)
      return c && "name" in c && c.name ? `#${c.name}` : s
    })
    .trim()
}
