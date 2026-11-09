// discord.js の Client の代わり。接続部が使う形だけを持つ（Gateway のモックは作らない。ADR 0011）。
// 発言は say で作り、接続部の handleMessage に渡す。Bot の送信は sent に記録する

import { EventEmitter } from "node:events"
import { ChannelType, type Client, type Interaction, type Message } from "discord.js"

export const BOT_ID = "900"
export const BOT_ROLE = "950"
const NAMES: Record<string, string> = { "1": "アリス", "2": "ボブ", [BOT_ID]: "AI係" }

type SendPayload = { content?: string; files?: { attachment: string; name: string }[]; reply?: { messageReference: string }; components?: unknown[] }
export type Sent = SendPayload & { channel: string }
type FakeAttachment = { id: string; name: string; size: number; contentType: string; url: string }

export function fakeDiscord() {
  const emitter = new EventEmitter()
  const channels = new Map<string, ReturnType<typeof channel>>()
  const messages = new Map<string, { id: string; channel: unknown; author: { id: string } }>()
  const sent: Sent[] = []
  const typing: string[] = []
  let seq = 5000

  function channel(id: string, opts: { name?: string; parentId?: string; dm?: boolean } = {}) {
    const ch = {
      id,
      name: opts.name,
      type: opts.dm ? ChannelType.DM : opts.parentId ? ChannelType.PublicThread : ChannelType.GuildText,
      parentId: opts.parentId ?? null,
      isThread: () => opts.parentId !== undefined,
      isDMBased: () => !!opts.dm,
      isSendable: () => true,
      async send(p: SendPayload) {
        sent.push({ channel: id, ...p })
        return makeMessage(ch, BOT_ID, p.content ?? "")
      },
      async sendTyping() {
        typing.push(id)
      },
      messages: {
        async fetch(arg: string | { limit: number }): Promise<unknown> {
          if (typeof arg === "string") {
            const m = messages.get(arg)
            if (!m || m.channel !== ch) throw new Error("Unknown Message")
            return m
          }
          // 新しい順で返す（discord.js と同じ）
          const list: { id: string; channel: unknown }[] = [...messages.values()].filter((m) => m.channel === ch).slice(-arg.limit).reverse()
          return new Map(list.map((m) => [m.id, m]))
        },
      },
    }
    channels.set(id, ch)
    return ch
  }

  function makeMessage(
    ch: ReturnType<typeof channel>,
    author: string,
    content: string,
    extra: { users?: string[]; roles?: Record<string, string>; everyone?: boolean; replyTo?: string; attachments?: FakeAttachment[] } = {},
  ) {
    const user = (id: string) => ({ id, bot: id === BOT_ID, displayName: NAMES[id] ?? id })
    const m = {
      id: String(++seq),
      content,
      author: user(author),
      member: null,
      webhookId: null,
      channel: ch,
      createdTimestamp: 1_700_000_000_000 + seq,
      guild: ch.isDMBased() ? null : { members: { me: { roles: { botRole: { id: BOT_ROLE } } } } },
      attachments: new Map((extra.attachments ?? []).map((a) => [a.id, a])),
      reference: extra.replyTo ? { messageId: extra.replyTo } : null,
      mentions: {
        users: new Map((extra.users ?? []).map((id) => [id, user(id)])),
        members: null,
        roles: new Map(Object.entries(extra.roles ?? {}).map(([id, name]) => [id, { id, name }])),
        channels: new Map(),
        everyone: !!extra.everyone,
        // discord.js は、返信先の発言の送り主を入れる
        repliedUser: extra.replyTo ? user(messages.get(extra.replyTo)!.author.id) : null,
      },
      async react(emoji: string) {
        sent.push({ channel: ch.id, content: `react:${emoji}` })
      },
      async edit(p: { content: string }) {
        sent.push({ channel: ch.id, content: `edit:${p.content}` })
      },
    }
    messages.set(m.id, m)
    return m
  }

  const client = Object.assign(emitter, {
    user: { id: BOT_ID, tag: "AI係#0001" },
    async login() {
      queueMicrotask(() => emitter.emit("clientReady"))
      return "token"
    },
    async destroy() {},
    channels: { cache: channels, fetch: async (id: string) => channels.get(id) ?? null },
    users: {
      fetch: async (id: string) => ({ id, dmChannel: channels.get(`dm-${id}`), createDM: async () => channel(`dm-${id}`, { dm: true }) }),
    },
  })

  /** 人の発言を作る。接続部の handleMessage に渡す */
  const say = (ch: ReturnType<typeof channel>, author: string, content: string, extra?: Parameters<typeof makeMessage>[3]) =>
    makeMessage(ch, author, content, extra) as unknown as Message

  /** 承認のボタンを押す */
  function press(user: string, customId: string, content = "") {
    const replies: unknown[] = []
    const i = {
      isButton: () => true,
      customId,
      user: { id: user },
      message: { content },
      async reply(p: unknown) {
        replies.push({ reply: p })
      },
      async update(p: unknown) {
        replies.push({ update: p })
      },
    }
    return { interaction: i as unknown as Interaction, replies }
  }

  return { client: client as unknown as Client, channel, say, press, sent, typing, messages }
}
