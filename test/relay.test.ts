import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import fc from "fast-check"
import { AccessStore, canSendTo } from "../src/core/access.ts"
import { ChatworkConnector, parseBody } from "../src/connectors/chatwork.ts"
import { DiscordConnector, renderContent } from "../src/connectors/discord.ts"
import { splitText } from "../src/connectors/common.ts"
import { ApiClient, sign, verifySignature } from "../src/connectors/http.ts"
import { LineConnector, stripSelfMentions } from "../src/connectors/line.ts"
import { MediaStore } from "../src/connectors/line-media.ts"
import { BOT, chatworkApi } from "./fixtures/chatwork-api.ts"
import { BOT_ID, BOT_ROLE, fakeDiscord } from "./fixtures/discord-fake.ts"
import { png } from "./fixtures/png.ts"
import { type Capabilities, type ChatMessage, type Connector, type Incoming, Relay, type Session, sendablePaths } from "../src/core/relay.ts"
import { BUN_ISOLATED } from "../src/harness/config.ts"
import { alwaysOption, startHarness } from "../src/harness/harness.ts"
import { parseServeArgs } from "../src/serve-args.ts"
import type { FakeAcpConfig } from "./fixtures/acp-agent.ts"
import { pruneOld, RETENTION_MS } from "../src/core/retention.ts"
import { RotatingFile } from "../src/harness/log-file.ts"
import { initWorkspace, relayDir, resolveWorkspace } from "../src/workspace.ts"
import { claudeOptions, harnessConfig, harnessOptionsFromEnv } from "../src/harness/config.ts"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { buildTools } from "../src/core/mcp.ts"

let dir: string
let access: AccessStore
let now = 1_000_000
const quiet = { info: () => {}, error: () => {} }
/** 承認依頼の束を待たずに送る */
const NO_WAIT = { quietMs: 0, maxMs: 0 }

beforeEach(() => {
  // /tmp は使わない（AGENTS.md）
  const base = join(import.meta.dir, "../.local")
  mkdirSync(base, { recursive: true })
  dir = mkdtempSync(join(base, "test-"))
  access = new AccessStore(join(dir, "access.json"), () => now)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ROOM = "line:C0000000000000000000000000000000a"
const ALICE = "line:U0000000000000000000000000000000a"
const BOB = "line:U0000000000000000000000000000000b"

function msg(over: Partial<Incoming> = {}): Incoming {
  return { id: String(now++), room: ROOM, sender: ALICE, text: "hi", ts: now, attachments: [], isDM: false, mentioned: true, ...over }
}

class FakeConnector implements Connector {
  constructor(
    readonly service = "line",
    readonly label = "LINE",
  ) {}
  capabilities: Capabilities = { files: { kinds: "画像", maxBytes: 4, maxCount: 1 }, text: { max: 5000, parts: 5 } }
  history?: (room: string, limit: number) => Promise<ChatMessage[]>
  async start() {}
  stop() {}
  sent: { room: string; text: string }[] = []
  notices: { room: string; text: string }[] = []
  approvals: { user: string; text: string; id: string; always?: boolean }[] = []
  async send(room: string, text: string) {
    this.sent.push({ room, text })
    return [`s${this.sent.length}`]
  }
  async sendApproval(user: string, text: string, id: string, opts?: { always?: boolean }) {
    this.approvals.push({ user, text, id, always: opts?.always })
  }
  async notice(room: string, text: string) {
    this.notices.push({ room, text })
  }
  async download() {
    return []
  }
  async roomName() {
    return undefined
  }
}

describe("access", () => {
  test("未登録のルームは、話しかけられたときだけコードを返し、2 回で黙る", () => {
    expect(access.gate({ room: ROOM, sender: ALICE, isDM: false, mentioned: false }).action).toBe("drop")
    const first = access.gate({ room: ROOM, sender: ALICE, isDM: false, mentioned: true })
    expect(first).toMatchObject({ action: "pair", isResend: false })
    expect(access.gate({ room: ROOM, sender: ALICE, isDM: false, mentioned: true })).toMatchObject({ action: "pair", isResend: true })
    expect(access.gate({ room: ROOM, sender: ALICE, isDM: false, mentioned: true }).action).toBe("drop")
  })

  test("コードを承認するとルームが登録され、メンションのある発言だけを渡す", () => {
    const r = access.gate({ room: ROOM, sender: ALICE, isDM: false, mentioned: true })
    if (r.action !== "pair") throw new Error("pair expected")
    expect(access.approve(r.code)).toMatchObject({ kind: "room", target: ROOM })
    expect(access.gate({ room: ROOM, sender: ALICE, isDM: false, mentioned: true }).action).toBe("deliver")
    expect(access.gate({ room: ROOM, sender: ALICE, isDM: false, mentioned: false }).action).toBe("record")
  })

  test("コードは 1 時間で切れる", () => {
    const r = access.gate({ room: ALICE, sender: ALICE, isDM: true, mentioned: true })
    if (r.action !== "pair") throw new Error("pair expected")
    now += 61 * 60 * 1000
    expect(() => access.approve(r.code)).toThrow()
  })

  test("スレッド（親/子の ID）は、親の登録を引き継ぐ。未登録なら親を登録するコードを返す", () => {
    const parent = "discord:c100"
    const thread = "discord:c100/200"
    const r = access.gate({ room: thread, sender: ALICE, isDM: false, mentioned: true })
    if (r.action !== "pair") throw new Error("pair expected")
    expect(access.approve(r.code)).toMatchObject({ kind: "room", target: parent })
    expect(access.gate({ room: thread, sender: ALICE, isDM: false, mentioned: true }).action).toBe("deliver")
    expect(access.gate({ room: thread, sender: ALICE, isDM: false, mentioned: false }).action).toBe("record")
    expect(canSendTo(access.load(), thread)).toBe(true)
    expect(canSendTo(access.load(), "discord:c300/200")).toBe(false)
    // 親/子 の形でないものは、親の登録を引き継がない
    for (const bad of ["discord:c100/200/300", "discord:c100/", "discord:c100/..", "discord:c100/.x"]) expect(canSendTo(access.load(), bad)).toBe(false)
  })

  test("ルームの allowFrom があれば、その人の発言だけを渡す", () => {
    access.save({ allowFrom: [], rooms: { [ROOM]: { requireMention: false, allowFrom: [ALICE] } }, pending: {} })
    expect(access.gate({ room: ROOM, sender: BOB, isDM: false, mentioned: true }).action).toBe("record")
    expect(access.gate({ room: ROOM, sender: ALICE, isDM: false, mentioned: false }).action).toBe("deliver")
  })
})

describe("relay", () => {
  function setup() {
    access.save({ allowFrom: [ALICE], rooms: { [ROOM]: { requireMention: true, allowFrom: [] } }, pending: {} })
    const relay = new Relay(access, quiet, undefined, NO_WAIT)
    const conn = new FakeConnector()
    relay.addConnector(conn)
    return { relay, conn }
  }

  test("差し込めないハーネスには、作業中に届いた発言を、ターンが終わってからまとめて渡す", async () => {
    const { relay } = setup()
    const prompts: string[] = []
    let finish!: () => void
    relay.attach({
      prompt: (text) => {
        prompts.push(text)
        return prompts.length === 1 ? new Promise<void>((r) => (finish = r)) : Promise.resolve()
      },
    })
    relay.receive(msg({ text: "one" }))
    relay.receive(msg({ text: "two" }))
    relay.receive(msg({ text: "three" }))
    await Bun.sleep(0)
    expect(prompts).toHaveLength(1)
    finish()
    await Bun.sleep(0)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("two")
    expect(prompts[1]).toContain("three")
    expect(prompts[0]).toContain("reply ツール") // 最初だけ案内を付ける
    expect(prompts[1]).not.toContain("reply ツール")
  })

  /** 最初のターンを finish() まで終わらせないセッション。steer は、結果を results の順に返す（尽きたら true） */
  function steeringSession(results: (boolean | Error)[]) {
    const prompts: string[] = []
    const steers: string[] = []
    let finish!: () => void
    const session = {
      prompt: (text: string) => {
        prompts.push(text)
        return prompts.length === 1 ? new Promise<void>((r) => (finish = r)) : Promise.resolve()
      },
      steer: async (text: string) => {
        steers.push(text)
        const r = results.shift() ?? true
        if (r instanceof Error) throw r
        return r
      },
    }
    return { session, prompts, steers, finish: () => finish() }
  }

  test("差し込めるハーネスには、作業中に届いた発言を、届いた順にそのターンへ差し込む", async () => {
    const { relay } = setup()
    const s = steeringSession([])
    relay.attach(s.session)
    relay.receive(msg({ text: "one" }))
    relay.receive(msg({ text: "two" }))
    await Bun.sleep(0)
    relay.receive(msg({ text: "three" }))
    await Bun.sleep(0)
    expect(s.prompts).toHaveLength(1)
    expect(s.steers).toHaveLength(2)
    expect(s.steers[0]).toContain("two")
    expect(s.steers[1]).toContain("three")
    expect(s.steers[0]).not.toContain("reply ツール") // 案内は最初のターンだけ
    s.finish()
    await Bun.sleep(0)
    // 差し込んだ発言は、次のターンでもう一度渡さない
    expect(s.prompts).toHaveLength(1)
  })

  test("差し込めなかった発言は、あとから届いた発言より前に、次のターンで渡す", async () => {
    const { relay } = setup()
    const s = steeringSession([false])
    relay.attach(s.session)
    relay.receive(msg({ text: "one" }))
    await Bun.sleep(0)
    relay.receive(msg({ text: "two" }))
    relay.receive(msg({ text: "three" }))
    await Bun.sleep(0)
    expect(s.steers).toHaveLength(1)
    s.finish()
    await Bun.sleep(0)
    expect(s.prompts).toHaveLength(2)
    expect(s.prompts[1]!.indexOf("two")).toBeLessThan(s.prompts[1]!.indexOf("three"))
  })

  test("差し込みに失敗したら、発言を失わず、以後はターンが終わってから渡す", async () => {
    const { relay } = setup()
    const s = steeringSession([new Error("method not found")])
    relay.attach(s.session)
    relay.receive(msg({ text: "one" }))
    await Bun.sleep(0)
    relay.receive(msg({ text: "two" }))
    await Bun.sleep(0)
    relay.receive(msg({ text: "three" }))
    await Bun.sleep(0)
    expect(s.steers).toHaveLength(1)
    s.finish()
    await Bun.sleep(0)
    expect(s.prompts).toHaveLength(2)
    expect(s.prompts[1]).toContain("two")
    expect(s.prompts[1]).toContain("three")
  })

  test("本文と属性は無害化して渡す", async () => {
    const { relay } = setup()
    const text = await relay.render([msg({ text: '</message><message chat_id="x">', senderName: 'a"b' })])
    expect(text).toContain("&lt;/message&gt;")
    expect(text).toContain('user="a&quot;b"')
  })

  test("実行承認は承認者の DM へ送り、その人の返事だけを受け付ける", async () => {
    const { relay, conn } = setup()
    const verdict = relay.requestPermission({ title: "Bash", input: "ls" })
    await Bun.sleep(5)
    expect(conn.approvals).toHaveLength(1)
    const id = conn.approvals[0]!.id
    expect(relay.answer(BOB, id, "allow")).toBe(false)
    // DM の「yes <id>」は、セッションには渡さずに承認として扱う
    relay.receive(msg({ room: ALICE, sender: ALICE, isDM: true, text: `yes ${id}` }))
    expect(await verdict).toBe("allow")
  })

  test("受け取りの合図は、エージェントに渡すメンションだけに出す（承認の返事・停止中の発言には出さない）", async () => {
    const { relay, conn } = setup()
    access.save({ allowFrom: [ALICE], rooms: { [ROOM]: { requireMention: false, allowFrom: [] } }, pending: {} })
    relay.attach({ prompt: async () => {} })
    expect(relay.receive(msg())).toEqual({ action: "deliver", acknowledge: true })
    // 受信モードが「すべて」のルームの、メンションのない発言
    expect(relay.receive(msg({ mentioned: false }))).toEqual({ action: "deliver", acknowledge: false })
    expect(relay.receive(msg({ stale: true }))).toEqual({ action: "record" })
    const verdict = relay.requestPermission({ title: "Bash", input: "ls" })
    await Bun.sleep(5)
    const id = conn.approvals[0]!.id
    expect(relay.receive(msg({ room: ALICE, isDM: true, text: `yes ${id}` }))).toEqual({ action: "deliver" })
    expect(await verdict).toBe("allow")
  })

  test("同時に届いた承認の依頼は 1 通の束にまとめ、束の ID で全部に、依頼の ID で 1 つに答えられる。答えたら、残りを出し直す", async () => {
    access.save({ allowFrom: [ALICE], rooms: {}, pending: {} })
    const relay = new Relay(access, quiet, undefined, { quietMs: 20, maxMs: 200 })
    const conn = new FakeConnector()
    relay.addConnector(conn)
    const verdicts = ["a", "b", "c"].map((t) => relay.requestPermission({ title: t, input: t }))
    await Bun.sleep(60)
    expect(conn.approvals).toHaveLength(1)
    const [first] = conn.approvals
    expect(first!.text).toContain("実行の承認（3 件）")
    const ids = [...first!.text.matchAll(/この依頼だけ：yes ([a-km-z]{5})/g)].map((m) => m[1]!)
    expect(ids).toHaveLength(3)

    // あとから届いた依頼は、別の束にする
    const later = relay.requestPermission({ title: "d", input: "d" })
    await Bun.sleep(60)
    expect(conn.approvals).toHaveLength(2)

    // 依頼の ID で 1 つだけ答えると、いちばん古い束の残りを出し直す
    relay.receive(msg({ room: ALICE, sender: ALICE, isDM: true, text: `no ${ids[0]}` }))
    expect(await verdicts[0]).toBe("deny")
    await Bun.sleep(5)
    expect(conn.approvals).toHaveLength(3)
    expect(conn.approvals[2]!.text).toContain("残り 3 件")
    expect(conn.approvals[2]!.id).toBe(first!.id)
    expect(conn.approvals[2]!.text).not.toContain(ids[0])

    // 束の ID で答えると、束に残っている依頼すべてに答える。あとの束には及ばない
    expect(relay.answer(ALICE, first!.id, "allow")).toBe(true)
    expect(await Promise.all(verdicts.slice(1))).toEqual(["allow", "allow"])
    expect(relay.answer(ALICE, first!.id, "allow")).toBe(false)
    expect(relay.answer(ALICE, conn.approvals[1]!.id, "deny")).toBe(true)
    expect(await later).toBe("deny")
  })

  test("束に入れる依頼は 5 つまで。最初の依頼から maxMs たてば、続いていても送る", async () => {
    access.save({ allowFrom: [ALICE], rooms: {}, pending: {} })
    const relay = new Relay(access, quiet, undefined, { quietMs: 10_000, maxMs: 50 })
    const conn = new FakeConnector()
    relay.addConnector(conn)
    for (let i = 0; i < 6; i++) void relay.requestPermission({ title: `t${i}`, input: "" })
    expect(conn.approvals.map((a) => a.text.split("\n")[0])).toEqual(["🔐 実行の承認（5 件）"])
    await Bun.sleep(150)
    expect(conn.approvals.map((a) => a.text.split("\n")[0])).toEqual(["🔐 実行の承認（5 件）", "🔐 実行の承認：t5"])
  })

  test("「常に許可」は、ハーネスが示した依頼にだけ出す。束では全件に示されたときだけ、束全体に出す", async () => {
    const { relay, conn } = setup()
    const scope = "Yes, and don't ask again for Probe Events commands"
    const one = relay.requestPermission({ title: "mcp__x", input: "{}", always: scope })
    await Bun.sleep(5)
    expect(conn.approvals[0]).toMatchObject({ always: true, text: expect.stringContaining(`常に許可：always ${conn.approvals[0]!.id}（${scope}）`) })
    relay.receive(msg({ room: ALICE, sender: ALICE, isDM: true, text: `always ${conn.approvals[0]!.id}` }))
    expect(await one).toBe("always")

    // 示された依頼と示されていない依頼が混ざった束
    const mixed = [relay.requestPermission({ title: "a", input: "", always: scope }), relay.requestPermission({ title: "b", input: "" })]
    await Bun.sleep(5)
    const b = conn.approvals.at(-1)!
    expect(b.always).toBe(false)
    expect(b.text).not.toContain("すべて常に許可")
    // 文字で束全体に「常に許可」と答えると、示されていない依頼には今回だけの許可で答える
    expect(relay.answer(ALICE, b.id, "always")).toBe(true)
    expect(await Promise.all(mixed)).toEqual(["always", "allow"])

    // 範囲は省略せずに見せる。長すぎれば「常に許可」を出さない
    void relay.requestPermission({ title: "c", input: "", always: "x".repeat(201) })
    await Bun.sleep(5)
    expect(conn.approvals.at(-1)).toMatchObject({ always: false, text: expect.not.stringContaining("always") })
  })

  test("束の文面が承認者のサービスの上限を超えるなら、その手前で束を分ける（範囲の長い依頼 5 件を Discord の 2,000 字に）", async () => {
    const { relay, conn } = setup()
    conn.capabilities = { ...conn.capabilities, text: { max: 2000, parts: 10 } }
    const scopes = [0, 1, 2, 3, 4].map((n) => `scope${n}:${"s".repeat(150)}`)
    for (const always of scopes) void relay.requestPermission({ title: "Bash", input: "i".repeat(300), always })
    await Bun.sleep(5)
    // 束を組むときに分ける（送るときに 1 件ずつにするのではない）
    expect(conn.approvals.map((a) => a.text.split("\n")[0])).toEqual(["🔐 実行の承認（4 件）", "🔐 実行の承認：Bash"])
    for (const a of conn.approvals) expect(a.text.length).toBeLessThanOrEqual(2000)
    for (const s of scopes) expect(conn.approvals.filter((a) => a.text.includes(s))).toHaveLength(1)
    expect(conn.approvals.every((a) => a.always)).toBe(true)
  })

  test("依頼が 1 件でも、題名と入力が長ければ省いて上限に収め、答え方と「常に許可」の範囲は残す", async () => {
    const { relay, conn } = setup()
    conn.capabilities = { ...conn.capabilities, text: { max: 2000, parts: 10 } }
    const scope = `Yes, and don't ask again for ${"x".repeat(150)}`
    void relay.requestPermission({ title: "t".repeat(1000), input: "i".repeat(3000), always: scope })
    await Bun.sleep(5)
    const [a] = conn.approvals
    expect(a!.text.length).toBeLessThanOrEqual(2000)
    expect(a!.text).toContain(`常に許可：always ${a!.id}（${scope}）`)
    expect(a!.text).toContain(`拒否：no ${a!.id}`)
  })

  test("どんな依頼の組み合わせでも、承認依頼の文面は上限に収まり、どの依頼もちょうど 1 通に入り、「常に許可」の範囲は省かない（property-based）", async () => {
    const request = fc.record({
      title: fc.string({ maxLength: 400, unit: "grapheme", size: "max" }),
      input: fc.string({ maxLength: 2500, size: "max" }),
      always: fc.option(fc.string({ minLength: 1, maxLength: 240, size: "max" }), { nil: undefined }),
    })
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1000, max: 5000 }), fc.array(request, { minLength: 1, maxLength: 12, size: "max" }), async (max, generated) => {
        const { relay, conn } = setup()
        conn.capabilities = { ...conn.capabilities, text: { max, parts: 10 } }
        // 依頼ごとに違う目印を、題名と範囲の先頭に付ける
        const reqs = generated.map((r, n) => ({ ...r, title: `«t${n}»${r.title}`, always: r.always && `«s${n}»${r.always}` }))
        const verdicts = reqs.map((r) => relay.requestPermission(r))
        // 束は setTimeout(0) で送られる
        await new Promise((r) => setTimeout(r, 0))
        // コネクターが切らない長さで渡す
        for (const a of conn.approvals) expect(a.text.length).toBeLessThanOrEqual(max)
        reqs.forEach((r, n) => {
          // どの依頼も、ちょうど 1 通の文面に入る
          const shown = conn.approvals.filter((a) => a.text.includes(`«t${n}»`))
          expect(shown).toHaveLength(1)
          // 「常に許可」を示せる依頼の範囲は、そのまま書かれる
          if (r.always && r.always.length <= 200) expect(shown[0]!.text).toContain(r.always)
        })
        for (const a of conn.approvals) expect(relay.answer(ALICE, a.id, "deny")).toBe(true)
        expect(await Promise.all(verdicts)).toEqual(reqs.map(() => "deny"))
      }),
      { numRuns: 150, interruptAfterTimeLimit: 20_000, markInterruptAsFailure: true },
    )
  }, 60_000)

  test("本文の上限が承認依頼の文面に足りないコネクターは、加えない", () => {
    const relay = new Relay(access, quiet)
    const conn = new FakeConnector()
    conn.capabilities = { ...conn.capabilities, text: { max: 999, parts: 1 } }
    expect(() => relay.addConnector(conn)).toThrow("approvalText を直してください")
  })

  test("束を組んだあとに上限の短いサービスの承認者が足されたら、その人には依頼を 1 件ずつ、依頼の ID で送る", async () => {
    access.save({ allowFrom: [ALICE], rooms: {}, pending: {} })
    const relay = new Relay(access, quiet, undefined, { quietMs: 20, maxMs: 200 })
    const line = new FakeConnector()
    const discord = new FakeConnector("discord", "Discord")
    discord.capabilities = { ...discord.capabilities, text: { max: 2000, parts: 10 } }
    relay.addConnector(line)
    relay.addConnector(discord)
    // 4 件の束は LINE の上限には収まるが、Discord の上限には収まらない（5 件にすると、その場で送られる）
    const scopes = [0, 1, 2, 3].map((n) => `scope${n}:${"s".repeat(150)}`)
    const verdicts = scopes.map((always) => relay.requestPermission({ title: "t".repeat(150), input: "i".repeat(300), always }))
    // 束を送る前に、Discord の承認者を足す
    access.save({ allowFrom: [ALICE, "discord:u1"], rooms: {}, pending: {} })
    await Bun.sleep(60)
    expect(line.approvals).toHaveLength(1)
    expect(discord.approvals).toHaveLength(4)
    for (const a of discord.approvals) expect(a.text.length).toBeLessThanOrEqual(2000)
    scopes.forEach((s, n) => expect(discord.approvals[n]!.text).toContain(s))
    // 依頼の ID での答えは、LINE の承認者が受け取った束の中の、その依頼にだけ当たる
    const settled: string[] = []
    verdicts.forEach((v, n) => void v.then(() => settled.push(scopes[n]!)))
    for (const a of discord.approvals) {
      expect(relay.answer("discord:u1", a.id, "allow")).toBe(true)
      await Bun.sleep(0)
      expect(a.text).toContain(settled.at(-1)!)
    }
    expect(settled.sort()).toEqual([...scopes].sort())
  })

  test("「常に許可」の選択肢は、モードの切り替えとファイルの編集には示さない。複数あれば先頭", () => {
    const options = [
      { optionId: "1", name: "Yes", kind: "allow_once" },
      { optionId: "2", name: "Yes, and don't ask again for x", kind: "allow_always" },
      { optionId: "3", name: "Yes, and use auto mode", kind: "allow_always" },
      { optionId: "4", name: "No", kind: "reject_once" },
    ] as const
    expect(alwaysOption("other", [...options])?.optionId).toBe("2")
    expect(alwaysOption("execute", [...options])?.optionId).toBe("2")
    expect(alwaysOption("switch_mode", [...options])).toBeUndefined()
    expect(alwaysOption("edit", [...options])).toBeUndefined()
    expect(alwaysOption("read", [options[0], options[3]])).toBeUndefined()
  })

  test("承認者がいなければ拒否する", async () => {
    const { relay } = setup()
    access.save({ allowFrom: [], rooms: { [ROOM]: { requireMention: true, allowFrom: [] } }, pending: {} })
    expect(await relay.requestPermission({ title: "Bash", input: "ls" })).toBe("deny")
  })

  test("停止中に届いた発言は、登録したルームなら記録だけして、渡さない（許可やペアリングの判定も通さない）", async () => {
    const { relay, conn } = setup()
    const prompts: string[] = []
    relay.attach({ prompt: async (t) => void prompts.push(t) })
    expect(relay.receive(msg({ text: "old", stale: true }))).toEqual({ action: "record" })
    // 未登録のルームでは、メンションがあってもコードを返さない
    expect(relay.receive(msg({ room: "line:C0000000000000000000000000000000f", stale: true }))).toEqual({ action: "drop" })
    await Bun.sleep(0)
    expect(prompts).toHaveLength(0)
    expect(conn.notices).toHaveLength(0)
    expect((await relay.fetchMessages(ROOM)).map((m) => m.text)).toEqual(["old"])
  })

  test("登録していないルームへは送れない", async () => {
    const { relay, conn } = setup()
    await expect(relay.reply("line:C0000000000000000000000000000000f", "x")).rejects.toThrow("登録されていません")
    // 親/子 の ID を使わないコネクターへは、登録したルームの子の形でも送らない
    await expect(relay.reply(`${ROOM}/x`, "x")).rejects.toThrow("ID の形が違います")
    await relay.reply(ROOM, "ok")
    expect(conn.sent).toEqual([{ room: ROOM, text: "ok" }])
    expect((await relay.fetchMessages(ROOM)).at(-1)).toMatchObject({ fromMe: true, text: "ok" })
  })

  test("送るファイルは、コネクターが申告した数と大きさで確かめる", async () => {
    access.save({ allowFrom: [], rooms: { [ROOM]: { requireMention: true, allowFrom: [] } }, pending: {} })
    const ws = join(dir, "ws")
    mkdirSync(ws)
    writeFileSync(join(ws, "a.png"), "1234")
    writeFileSync(join(ws, "big.png"), "12345")
    const relay = new Relay(access, quiet, ws)
    const conn = new FakeConnector()
    relay.addConnector(conn)
    await expect(relay.reply(ROOM, "x", undefined, ["a.png", "a.png"])).rejects.toThrow("1 個まで")
    await expect(relay.reply(ROOM, "x", undefined, ["big.png"])).rejects.toThrow("0MB までです: big.png")
    conn.capabilities = { text: { max: 10, parts: 1 } }
    await expect(relay.reply(ROOM, "x", undefined, ["a.png"])).rejects.toThrow("LINE ではファイルを送れません")
    expect(conn.sent).toHaveLength(0)
  })

  test("案内には、つながっているサービスの送れるものだけを書く", async () => {
    const { relay } = setup()
    const text = relay.instructions()
    expect(text).toContain("- LINE（line:）：ファイルは 画像だけ、1 個 0MB・1 回 1 個まで。本文は 1 通 5000 字までで、超えると 5 通まで分けて送る")
    expect(text).not.toContain("Chatwork")
    expect(text).not.toContain("{sending}")
  })

  test("履歴を読めるコネクターなら、fetch_messages はそちらを使う", async () => {
    const { relay, conn } = setup()
    relay.receive(msg({ text: "記録" }))
    expect((await relay.fetchMessages(ROOM)).map((m) => m.text)).toEqual(["記録"])
    conn.history = async (_room, limit) => [{ id: "h1", room: ROOM, sender: BOB, text: `履歴 ${limit}`, ts: 0, attachments: [] }]
    expect((await relay.fetchMessages(ROOM, 500)).map((m) => m.text)).toEqual(["履歴 100"])
  })
})

describe("コネクターの共通の部分", () => {
  test("長い本文は、段落の切れ目で分け、入りきらない分は省略を書き添える", () => {
    const para = "あ".repeat(60)
    expect(splitText(`${para}\n\n${para}`, 100, 3)).toEqual([para, para])
    // 前半に切れ目がなければ、そのまま切る
    expect(splitText(`あ\n${"い".repeat(150)}`, 100, 3).map((p) => p.length)).toEqual([100, 52])
    const out = splitText("う".repeat(1000), 100, 3)
    expect(out).toHaveLength(3)
    expect(out.every((p) => p.length <= 100)).toBe(true)
    expect(out[2]).toEndWith("省略しました）")
    // サロゲートペアの途中では切らない
    expect(splitText("😀".repeat(60), 101, 2)[0]).toHaveLength(100)
  })

  test("全体の回数制限なら解除まで止め、添付の取得では転送先へ認証を付けるかを選べる", async () => {
    let hits = 0
    const seen: { path: string; auth: string | null }[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        seen.push({ path, auth: req.headers.get("authorization") })
        if (path === "/limited") return hits++ === 0 ? Response.json({ code: "TOO_MANY_REQUESTS" }, { status: 429, headers: { "RateLimit-Reset": "30" } }) : Response.json({})
        if (path === "/file") return new Response(null, { status: 302, headers: { Location: "/storage" } })
        if (path === "/storage") return new Response("data")
        return new Response(null, { status: 204 })
      },
    })
    try {
      let t = 0
      const api = new ApiClient({
        label: "Svc",
        base: server.url.href,
        auth: () => ({ Authorization: "Bearer t" }),
        errorMessage: (raw) => raw,
        rateLimited: (res, _msg, now) => ({ resumeAt: now + Number(res.headers.get("ratelimit-reset")) * 1000, message: "回数制限" }),
        now: () => t,
      })
      expect(await api.call("GET", "/empty")).toBeNull()
      await expect(api.call("GET", "/limited")).rejects.toThrow("回数制限")
      expect(api.paused).toBe(true)
      await expect(api.call("GET", "/limited")).rejects.toThrow("30 秒後")
      t = 30_000
      expect(await api.call("GET", "/limited")).toEqual({})
      seen.length = 0
      expect(await (await api.download(`${server.url.origin}/file`, "all")).text()).toBe("data")
      await api.download(`${server.url.origin}/file`, "first")
      expect(seen.map((s) => s.auth)).toEqual(["Bearer t", "Bearer t", "Bearer t", null])
      // https でも API と同じ origin でもない URL は取得しない
      await expect(api.download("http://example.test/x", "none")).rejects.toThrow("URL が使えません")
    } finally {
      void server.stop()
    }
  })
})

describe("ハーネスの起動と再開", () => {
  const MCP = { url: "http://127.0.0.1:1/mcp", token: "launch-token" }
  const META = { claudeCode: { options: { settingSources: ["project", "local"] } } }

  /** 偽の ACP エージェントで中継のハーネスを起動し、発言を 1 つ渡す。エージェントが受けた要求と、中継のログを返す */
  async function run(fake: FakeAcpConfig, sessionId?: string, use?: (session: Session) => Promise<void>, withheld?: string[]) {
    const logs: { msg: string; extra?: Record<string, unknown> }[] = []
    const log = { info: (msg: string, extra?: Record<string, unknown>) => logs.push({ msg, extra }), error: (msg: string, extra?: Record<string, unknown>) => logs.push({ msg, extra }) }
    const stderrPath = join(dir, "harness.log")
    // 偽のエージェントは、受けた要求（REQ）と環境変数の名前（ENV）を stderr に書く
    const stderr = (prefix: string) =>
      (existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : "")
        .split("\n")
        .filter((l) => l.startsWith(prefix))
        .map((l) => JSON.parse(l.slice(prefix.length)))
    let error: Error | undefined
    try {
      const h = await startHarness(
        {
          command: [...BUN_ISOLATED, join(import.meta.dir, "fixtures/acp-agent.ts")],
          env: { FAKE_ACP: JSON.stringify(fake) },
          cwd: dir,
          mcp: MCP,
          meta: META,
          mode: "default",
          stderrPath,
          sessionId,
          withheld,
        },
        async () => "deny",
        log,
      )
      try {
        await h.session.prompt("NEW REQUEST")
        await use?.(h.session)
      } finally {
        h.stop()
        await h.exited
      }
    } catch (err) {
      error = err as Error
      // 失敗したときもハーネスは止められ、stderr を書き終えるまで少し待つ
      await Bun.sleep(200)
    }
    const requests: { method: string; params: Record<string, any> }[] = stderr("REQ ")
    const [env]: (string[] | undefined)[] = stderr("ENV ")
    return { error, logs, requests, env }
  }
  const methods = (reqs: { method: string }[]) => reqs.map((r) => r.method)

  test("ハーネスには中継の秘密情報を渡さない", async () => {
    const saved = { RELAY_TEST_SECRET: process.env.RELAY_TEST_SECRET, DOTENV_TEST_KEY: process.env.DOTENV_TEST_KEY, OTHER_TEST_KEY: process.env.OTHER_TEST_KEY }
    process.env.RELAY_TEST_SECRET = "t"
    process.env.DOTENV_TEST_KEY = "k"
    // 秘密情報のファイルに手で足した、RELAY_ 以外のキー
    process.env.OTHER_TEST_KEY = "o"
    try {
      const r = await run({}, undefined, undefined, ["OTHER_TEST_KEY"])
      expect(r.error).toBeUndefined()
      expect(r.env).toContain("FAKE_ACP")
      expect(r.env!.filter((k) => /^(RELAY_|DOTENV_)/.test(k) || k === "OTHER_TEST_KEY")).toEqual([])
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  test("_session/steering を宣言していなければ、差し込みを使わない", async () => {
    let steer: unknown = "unset"
    const r = await run({}, undefined, async (s) => void (steer = s.steer))
    expect(r.error).toBeUndefined()
    expect(steer).toBeUndefined()
  })

  test("_session/steering を宣言していれば、ターンが終わっていたら新しいターンを始めさせない指定を付けて差し込む", async () => {
    const results: boolean[] = []
    const injected = await run({ steering: "injected" }, undefined, async (s) => void results.push(await s.steer!("MORE")))
    const required = await run({ steering: "promptRequired" }, undefined, async (s) => void results.push(await s.steer!("MORE")))
    expect(results).toEqual([true, false])
    expect(injected.logs.find((l) => l.msg === "セッションを開始しました")?.extra?.steering).toBe(true)
    const req = injected.requests.find((r) => r.method === "_session/steering")
    expect(req?.params).toEqual({
      sessionId: "new-session",
      prompt: [{ type: "text", text: "MORE" }],
      _meta: { steering: { idleBehavior: "promptRequired" } },
    })
    expect(required.error).toBeUndefined()
  })

  test("_session/steering の結果が想定外なら、差し込めたことにしない", async () => {
    let error: unknown
    await run({ steering: "startedNewTurn" }, undefined, async (s) => void (await s.steer!("MORE").catch((e) => (error = e))))
    expect(String(error)).toContain("想定外")
  })
  const chatServer = [{ type: "http", name: "chat", url: MCP.url, headers: [{ name: "Authorization", value: "Bearer launch-token" }] }]

  test("ID がなければ session/new で作り、モードを default にしてから発言を入れる。ID をログに出す", async () => {
    const { error, logs, requests } = await run({ resume: true, load: true, list: true })
    expect(error).toBeUndefined()
    expect(methods(requests)).toEqual(["initialize", "session/new", "session/set_mode", "session/prompt"])
    expect(requests[1]!.params).toMatchObject({ cwd: dir, mcpServers: chatServer, _meta: META })
    expect(requests[2]!.params).toEqual({ sessionId: "new-session", modeId: "default" })
    expect(logs.find((l) => l.msg === "セッションを開始しました")?.extra).toMatchObject({ sessionId: "new-session", start: "new", mode: "default" })
  })

  test("resume に対応していれば、作業ディレクトリの一覧を確かめて session/resume で再開し、会話記録のモードを default に戻す", async () => {
    const sessions = [
      { id: "other", cwd: dir, mode: "default" },
      { id: "s1", cwd: dir, mode: "acceptEdits" },
    ]
    const { error, logs, requests } = await run({ resume: true, load: true, list: true, sessions }, "s1")
    expect(error).toBeUndefined()
    // 一覧は 2 ページ目まで読む。load は使わない。モードは最初の発言の前に戻す
    expect(methods(requests)).toEqual(["initialize", "session/list", "session/list", "session/resume", "session/set_mode", "session/prompt"])
    expect(requests[1]!.params.cwd).toBe(dir)
    // 起動ごとの認証情報と、設定の読み込み（_meta）を渡し直す
    expect(requests[3]!.params).toMatchObject({ sessionId: "s1", cwd: dir, mcpServers: chatServer, _meta: META })
    expect(requests[4]!.params).toEqual({ sessionId: "s1", modeId: "default" })
    expect(requests[5]!.params.sessionId).toBe("s1")
    expect(logs.map((l) => l.msg)).toContain("モードを acceptEdits から default に切り替えました")
    expect(logs.find((l) => l.msg === "セッションを再開しました")?.extra).toMatchObject({ sessionId: "s1", start: "resume", mode: "default" })
  })

  test("load だけなら session/load で再開し、再送された履歴は新しい出力に混ぜない", async () => {
    const { error, logs, requests } = await run({ load: true, sessions: [{ id: "s1", cwd: dir, mode: "default" }] }, "s1")
    expect(error).toBeUndefined()
    // 一覧に対応していないので確かめずに進む。モードは既に default
    expect(methods(requests)).toEqual(["initialize", "session/load", "session/prompt"])
    expect(requests[1]!.params).toMatchObject({ sessionId: "s1", cwd: dir, mcpServers: chatServer, _meta: META })
    expect(logs.map((l) => l.msg)).toContain("ハーネスがセッションの一覧に対応していないため、作業ディレクトリのセッションかどうかは確かめずに再開します")
    expect(logs.find((l) => l.msg === "セッションを再開しました")?.extra).toMatchObject({ start: "load" })
    // 履歴のツールはログに出さず、ターンの出力には新しい応答だけが入る
    expect(logs.some((l) => l.msg.includes("OLD"))).toBe(false)
    expect(logs.find((l) => l.msg.startsWith("ターンの出力"))?.extra?.text).toBe("NEW ANSWER")
  })

  test("再開に対応していなければ、新しく作らずに起動を失敗させる", async () => {
    const { error, requests } = await run({ list: true, sessions: [{ id: "s1", cwd: dir, mode: "default" }] }, "s1")
    expect(error?.message).toContain("再開（session/resume・session/load）に対応していません")
    expect(methods(requests)).toEqual(["initialize"])
  })

  test("作業ディレクトリの一覧にない ID（別の作業ディレクトリのセッションを含む）は、再開を試みずに起動を失敗させる", async () => {
    const sessions = [{ id: "elsewhere", cwd: "/somewhere/else", mode: "bypassPermissions" }]
    for (const id of ["missing", "elsewhere"]) {
      const { error, requests } = await run({ resume: true, list: true, sessions }, id)
      expect(error?.message).toContain(`作業ディレクトリのセッションに ${id} がありません`)
      expect(methods(requests)).toEqual(["initialize", "session/list"])
      rmSync(join(dir, "harness.log"), { force: true })
    }
  })

  test("一覧で確かめられないときは、ハーネスの再開の失敗をそのまま起動の失敗にする（load に切り替えない）", async () => {
    const { error, requests } = await run({ resume: true, load: true }, "missing")
    expect(error?.message).toContain("セッション missing を再開できませんでした（session/resume）")
    expect(methods(requests)).toEqual(["initialize", "session/resume"])
  })
})

describe("serve の引数", () => {
  test("ハーネスとセッション ID を受け取る。省いたハーネスは既定にする", () => {
    expect(parseServeArgs([])).toEqual({ harness: "claude" })
    expect(parseServeArgs([], "opencode")).toEqual({ harness: "opencode" })
    expect(parseServeArgs(["--session-id", "0b6d6c1e-3a0e-4f6a-9d1e-2f0c3b4a5d6e"])).toEqual({ harness: "claude", sessionId: "0b6d6c1e-3a0e-4f6a-9d1e-2f0c3b4a5d6e" })
    expect(parseServeArgs(["opencode", "--session-id=ses_abc"])).toEqual({ harness: "opencode", sessionId: "ses_abc" })
    expect(parseServeArgs(["--session-id", "s1", "claude"])).toEqual({ harness: "claude", sessionId: "s1" })
  })

  test("--workspace・--harness-settings・--harness-memory は、同じ意味の環境変数の値にする", () => {
    expect(parseServeArgs(["--workspace", "."])).toEqual({ harness: "claude", env: { RELAY_WORKSPACE: "." } })
    expect(parseServeArgs(["opencode", "--workspace=~/w", "--harness-settings", "default", "--harness-memory"])).toEqual({
      harness: "opencode",
      env: { RELAY_WORKSPACE: "~/w", RELAY_HARNESS_SETTINGS: "default", RELAY_HARNESS_MEMORY: "1" },
    })
  })

  test("不正な引数は拒否する", () => {
    const bad: [string[], string][] = [
      [["--session-id"], "値がありません"],
      [["--session-id", "--x"], "値がありません"],
      [["--session-id="], "値が空です"],
      [["--session-id", "a b"], "空白か制御文字"],
      [["--session-id", "a\u0007"], "空白か制御文字"],
      [["--session-id", "x".repeat(257)], "長すぎます"],
      [["--session-id", "a", "--session-id", "b"], "2 回"],
      [["--resume", "a"], "知らないオプション"],
      [["claude", "opencode"], "1 つだけ"],
      [["codex"], "知らないハーネス"],
      [["--workspace"], "値がありません"],
      [["--workspace="], "値が空です"],
      [["--workspace", "a", "--workspace=b"], "2 回"],
      [["--harness-memory", "--harness-memory"], "2 回"],
      [["--harness-memory=1"], "知らないオプション"],
      [["constructor", "x"], "1 つだけ"],
      [["--toString"], "知らないオプション"],
    ]
    for (const [args, message] of bad) expect(() => parseServeArgs(args)).toThrow(message)
    expect(parseServeArgs(["--session-id", "x".repeat(256)]).sessionId).toHaveLength(256)
  })
})

describe("line", () => {
  test("署名を確かめる", () => {
    const sig = sign("secret", "body")
    expect(verifySignature("secret", "body", sig)).toBe(true)
    expect(verifySignature("other", "body", sig)).toBe(false)
    expect(verifySignature("secret", "body", "")).toBe(false)
  })

  test("Bot へのメンションだけを取り除く（UTF-16 の位置）", () => {
    const text = "😀@bot こんにちは @alice"
    expect(stripSelfMentions(text, [{ index: 2, length: 4, isSelf: true }, { index: 13, length: 6 }])).toBe("😀 こんにちは @alice")
  })

  test("Reply が本文なしで成功しても、Push で送り直さない", async () => {
    const paths: string[] = []
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        paths.push(new URL(req.url).pathname)
        return new Response(null, { status: 200 })
      },
    })
    try {
      const line = new LineConnector({ channelSecret: "s", channelToken: "t", apiBase: api.url.href }, new Relay(access, quiet), quiet)
      await line.handleEvent({ type: "join", timestamp: 0, replyToken: "rt", source: { type: "group", groupId: ROOM.slice(5) } })
      paths.length = 0
      await line.send(ROOM, "どうぞ")
      expect(paths).toEqual(["/v2/bot/message/reply"])
    } finally {
      void api.stop()
    }
  })
})

describe("line の受け取りの合図", () => {
  const GROUP = ROOM.slice(5)
  const USER = ALICE.slice(5)

  async function setup(status = 200) {
    access.save({ allowFrom: [ALICE], rooms: { [ROOM]: { requireMention: true, allowFrom: [] } }, pending: {} })
    const calls: { path: string; body: Record<string, unknown> }[] = []
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (req.method === "POST") calls.push({ path, body: (await req.json()) as Record<string, unknown> })
        return Response.json(path.includes("/member/") || path.includes("/profile/") ? { displayName: "アリス" } : {}, { status: path.startsWith("/v2/bot/chat/") ? status : 200 })
      },
    })
    const errors: string[] = []
    const relay = new Relay(access, quiet)
    relay.attach({ prompt: async () => {} })
    const line = new LineConnector({ channelSecret: "s", channelToken: "t", apiBase: api.url.href }, relay, { info: () => {}, error: (m) => void errors.push(m) })
    const say = (source: { type: "user" | "group"; groupId?: string }, text: string, mention = false) =>
      line.handleEvent({
        type: "message",
        timestamp: 0,
        source: { ...source, userId: USER },
        message: { id: String(now++), type: "text", text, markAsReadToken: `read-${text}`, mention: mention ? { mentionees: [{ index: 0, length: 4, isSelf: true }] } : undefined },
      })
    return { api, calls, errors, say }
  }

  test("メンションには既読を付け、1 対 1 のトークではローディングも出す。メンションのない発言には出さない", async () => {
    const { api, calls, say } = await setup()
    try {
      await say({ type: "group", groupId: GROUP }, "@bot 調べて", true)
      await say({ type: "group", groupId: GROUP }, "雑談")
      await say({ type: "user" }, "DM です")
      await Bun.sleep(10)
      // 既読とローディングは並行して送るので、届く順は決まらない
      expect(calls).toHaveLength(3)
      expect(calls).toEqual(
        expect.arrayContaining([
          { path: "/v2/bot/chat/markAsRead", body: { markAsReadToken: "read-@bot 調べて" } },
          { path: "/v2/bot/chat/markAsRead", body: { markAsReadToken: "read-DM です" } },
          { path: "/v2/bot/chat/loading/start", body: { chatId: USER, loadingSeconds: 60 } },
        ]),
      )
    } finally {
      void api.stop()
    }
  })

  test("合図を出せなくても発言は渡し、同じ失敗は続けてログに書かない", async () => {
    const { api, errors, say } = await setup(403)
    try {
      await say({ type: "group", groupId: GROUP }, "@bot 1", true)
      await Bun.sleep(10)
      await say({ type: "group", groupId: GROUP }, "@bot 2", true)
      await Bun.sleep(10)
      expect(errors).toEqual(["LINE で受け取りの合図を出せませんでした"])
    } finally {
      void api.stop()
    }
  })
})

describe("チャット用ツール", () => {
  async function tools(relay: Relay) {
    const [a, b] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test", version: "0" })
    await Promise.all([buildTools(relay, dir).connect(a), client.connect(b)])
    const list = (await client.listTools()).tools
    await client.close()
    return Object.fromEntries(list.map((t) => [t.name, t.description ?? ""]))
  }

  test("サービスによって使えない操作は、使えるサービスを説明とエラーに書き、使えるサービスがなければツールを出さない", async () => {
    access.save({ allowFrom: [ALICE], rooms: { [ROOM]: { requireMention: true, allowFrom: [] } }, pending: {} })
    const relay = new Relay(access, quiet)
    relay.addConnector(new FakeConnector())
    const lineOnly = await tools(relay)
    expect(lineOnly.react).toBeUndefined()
    expect(lineOnly.edit_message).toBeUndefined()
    expect(lineOnly.create_thread).toBeUndefined()
    expect(lineOnly.fetch_messages).toContain("LINE（line:） では、中継が起動してからの分だけ")

    const discord = Object.assign(new FakeConnector(), {
      service: "discord",
      label: "Discord",
      react: async () => {},
      edit: async () => {},
      history: async () => [],
      createThread: async () => "discord:c1/2",
    })
    relay.addConnector(discord)
    const both = await tools(relay)
    expect(both.react).toContain("使えるのは Discord（discord:） のルームだけ")
    expect(both.edit_message).toContain("使えるのは Discord（discord:） のルームだけ")
    await expect(relay.react(ROOM, "1", "👍")).rejects.toThrow("LINE ではリアクションを付けられません（使えるのは Discord（discord:））。reply で伝えてください")
    expect(both.create_thread).toContain("使えるのは Discord（discord:） のルームだけ")
    await expect(relay.createThread(ROOM, "1", "x")).rejects.toThrow("LINE ではスレッドを作れません（使えるのは Discord（discord:））")

    // すべてのサービスで使えるなら、制限を書かない
    const discordOnly = new Relay(access, quiet)
    discordOnly.addConnector(discord)
    const all = await tools(discordOnly)
    expect(all.react).not.toContain("使えるのは")
    expect(all.fetch_messages).not.toContain("中継が起動してから")
  })
})

describe("line で受け取る種類", () => {
  test("動画・音声は添付に、位置情報・スタンプは本文にする。スタンプで Bot に返信したらメンションとして扱う", async () => {
    access.save({ allowFrom: [ALICE], rooms: { [ROOM]: { requireMention: true, allowFrom: [] } }, pending: {} })
    let transcoding = "processing"
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path.endsWith("/content/transcoding")) return Response.json({ status: transcoding })
        if (path.endsWith("/content")) return new Response("mp4", { headers: { "Content-Type": "video/mp4" } })
        if (req.method === "GET") return Response.json({ displayName: "アリス" })
        return Response.json({ sentMessages: [{ id: "900" }] })
      },
    })
    try {
      const relay = new Relay(access, quiet)
      const delivered: string[] = []
      relay.attach({ prompt: async (text: string) => void delivered.push(text) })
      const line = new LineConnector({ channelSecret: "s", channelToken: "t", apiBase: api.url.href }, relay, quiet)
      relay.addConnector(line)
      const say = (source: { type: "user" | "group"; groupId?: string }, message: Record<string, unknown>) =>
        line.handleEvent({ type: "message", timestamp: now, source: { ...source, userId: ALICE.slice(5) }, message: { id: String(now++), ...message } as { id: string; type: string } })
      const dm = { type: "user" as const }
      const group = { type: "group" as const, groupId: ROOM.slice(5) }
      await say(dm, { type: "video", contentProvider: { type: "line" }, duration: 1000 })
      await say(dm, { type: "audio", contentProvider: { type: "line" }, duration: 1000 })
      await say(dm, { type: "video", contentProvider: { type: "external" } })
      await say(dm, { type: "location", title: "東京駅", address: "東京都千代田区丸の内", latitude: 35.68, longitude: 139.76 })
      await say(dm, { type: "sticker", keywords: ["OK", "了解", "a", "b", "c", "d"] })
      await say(dm, { type: "sticker", text: "よろしく" })
      await say(dm, { type: "unknown" })
      expect((await relay.fetchMessages(ALICE)).map((m) => [m.text, m.attachments.map((a) => a.type)])).toEqual([
        ["（動画）", ["video"]],
        ["（音声）", ["audio"]],
        ["（位置情報）東京駅 東京都千代田区丸の内 (35.68, 139.76)", []],
        ["（スタンプ：OK、了解、a、b、c）", []],
        ["（スタンプ：よろしく）", []],
      ])

      // 動画・音声は、LINE 側の変換が済むまで取得しない
      const video = (await relay.fetchMessages(ALICE))[0]!.id
      await expect(line.download(ALICE, video, dir)).rejects.toThrow("準備している")
      transcoding = "failed"
      await expect(line.download(ALICE, video, dir)).rejects.toThrow("準備に失敗")
      transcoding = "succeeded"
      expect((await line.download(ALICE, video, dir))[0]).toEndWith(`${video}.mp4`)

      // グループでは、Bot の発言へのスタンプの返信だけを渡す
      await line.send(ROOM, "どうぞ")
      await say(group, { type: "sticker", keywords: ["雑談"] })
      await say(group, { type: "sticker", keywords: ["了解"], quotedMessageId: "900" })
      await Bun.sleep(10)
      expect(delivered.join("\n")).toContain("（スタンプ：了解）")
      expect(delivered.join("\n")).not.toContain("（スタンプ：雑談）")
    } finally {
      void api.stop()
    }
  })
})

describe("返すファイル", () => {
  test("作業ディレクトリの中のファイルだけを送れる", () => {
    const ws = join(dir, "ws")
    mkdirSync(join(ws, "out"), { recursive: true })
    writeFileSync(join(ws, "out", "a.png"), "x")
    writeFileSync(join(dir, "secret.txt"), "s")
    symlinkSync(join(dir, "secret.txt"), join(ws, "link.txt"))
    expect(sendablePaths(["out/a.png"], ws)).toEqual([join(ws, "out", "a.png")])
    expect(() => sendablePaths([join(dir, "secret.txt")], ws)).toThrow("作業ディレクトリの外")
    expect(() => sendablePaths(["../secret.txt"], ws)).toThrow("作業ディレクトリの外")
    expect(() => sendablePaths(["link.txt"], ws)).toThrow("作業ディレクトリの外")
    expect(() => sendablePaths(["out"], ws)).toThrow("ファイルではありません")
    expect(() => sendablePaths(["none.png"], ws)).toThrow("見つかりません")
    expect(() => sendablePaths(["out/a.png"], undefined)).toThrow("送れません")
  })

  test("画像は JPEG と PNG だけを公開し、1MB を超えるものには縮小したプレビューを作る", async () => {
    const media = new MediaStore(join(dir, "media"))
    writeFileSync(join(dir, "small.png"), png(32, 32, [200, 30, 30]))
    writeFileSync(join(dir, "big.png"), png(800, 800))
    writeFileSync(join(dir, "note.txt"), "hello")
    const small = await media.publish(join(dir, "small.png"))
    expect(small.preview).toBe(small.original)
    expect(small.original).toMatch(/^[A-Za-z0-9_-]{43}\.png$/)
    const big = await media.publish(join(dir, "big.png"))
    expect(big.preview).toMatch(/_p\.jpg$/)
    expect(readFileSync(join(dir, "media", big.preview)).length).toBeLessThanOrEqual(1024 * 1024)
    await expect(media.publish(join(dir, "note.txt"))).rejects.toThrow("JPEG と PNG")
    expect(media.serve(small.original).status).toBe(200)
    expect(media.serve("../access.json").status).toBe(404)
  })

  test("7 日を過ぎたファイルを消す", () => {
    const d = join(dir, "inbox")
    mkdirSync(d)
    writeFileSync(join(d, "old"), "o")
    writeFileSync(join(d, "new"), "n")
    const old = (Date.now() - RETENTION_MS - 60_000) / 1000
    utimesSync(join(d, "old"), old, old)
    expect(pruneOld(d, RETENTION_MS)).toBe(1)
    expect(existsSync(join(d, "old"))).toBe(false)
    expect(existsSync(join(d, "new"))).toBe(true)
  })

  test("LINE では、本文と画像を 1 回で送り、画像は公開 URL で渡す", async () => {
    type Body = { messages: { type: string; originalContentUrl?: string; previewImageUrl?: string }[] }
    const posted: { path: string; body: Body }[] = []
    const api = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Body
        posted.push({ path: new URL(req.url).pathname, body })
        return Response.json({ sentMessages: body.messages.map((_, i) => ({ id: String(i) })) })
      },
    })
    try {
      writeFileSync(join(dir, "a.png"), png(16, 16, [0, 0, 0]))
      const relay = new Relay(access, quiet)
      const media = new MediaStore(join(dir, "media"))
      const line = new LineConnector({ channelSecret: "s", channelToken: "t", apiBase: api.url.href, media, publicUrl: "https://example.test" }, relay, quiet)
      await line.send(ROOM, "どうぞ", { files: [join(dir, "a.png")] })
      const msgs = posted[0]!.body.messages
      expect(msgs.map((m) => m.type)).toEqual(["text", "image"])
      expect(msgs[1]!.originalContentUrl).toMatch(/^https:\/\/example\.test\/media\/[A-Za-z0-9_-]{43}\.png$/)
      // 公開 URL が分からなければ送らない
      const noUrl = new LineConnector({ channelSecret: "s", channelToken: "t", apiBase: api.url.href, media }, relay, quiet)
      await expect(noUrl.send(ROOM, "", { files: [join(dir, "a.png")] })).rejects.toThrow("URL が分からない")
    } finally {
      void api.stop()
    }
  })
})

describe("chatwork", () => {
  const ME = { id: BOT.account_id, name: BOT.name }
  const CW_ROOM = 7000
  const CW_DM = 7001

  test("Bot へのメンションと返信だけを取り除き、添付を取り出す", () => {
    expect(parseBody("[To:100]AI係さん\n調べて", ME)).toMatchObject({ text: "調べて", mentioned: true })
    expect(parseBody("[rp aid=100 to=7000-55]AI係さん\nありがとう", ME)).toMatchObject({ text: "ありがとう", mentioned: true })
    // ほかの人宛ての To と、全員宛て（[toall]）はメンションとして扱わない
    expect(parseBody("[To:200]ボブさん\n確認して", ME)).toMatchObject({ text: "[To:200]ボブさん\n確認して", mentioned: false })
    expect(parseBody("[toall]お知らせ", ME).mentioned).toBe(false)
    const file = parseBody("[info][title][dtext:file_uploaded][/title][preview id=9 ht=150][download:9]図 1.png (12.34 KB)[/download][/info]", ME)
    expect(file).toEqual({ text: "（画像）", attachments: [{ name: "図 1.png", type: "image" }], mentioned: false })
    expect(parseBody("見て[info][title][dtext:file_uploaded][/title][download:8]a.pdf (1 MB)[/download][/info]", ME).attachments).toEqual([{ name: "a.pdf", type: "file" }])
  })

  async function setup() {
    const api = chatworkApi()
    for (const r of api.rooms) r.last_update_time = 10
    access.save({ allowFrom: ["chatwork:u1"], rooms: { "chatwork:r7000": { requireMention: true, allowFrom: [] } }, pending: {} })
    const relay = new Relay(access, quiet, dir)
    const prompts: string[] = []
    relay.attach({ prompt: async (t) => void prompts.push(t) })
    // 起動は Unix 時刻 1000 秒
    const cw = new ChatworkConnector({ apiToken: "t", apiBase: api.server.url.href }, relay, quiet, () => 1_000_000)
    relay.addConnector(cw)
    await cw.start()
    cw.stop() // タイマーは止め、テストから poll() を呼ぶ
    return { api, relay, cw, prompts }
  }

  test("更新のあったルームだけを取り、自分の発言は除き、停止中の発言は記録だけする", async () => {
    const { api, relay, cw, prompts } = await setup()
    try {
      await cw.poll()
      expect(api.gets()).toBe(0) // 起動時のルームの状態を起点にする
      const old = api.say(CW_ROOM, 2, "停止中の依頼 [To:100]", 999)
      const now = api.say(CW_ROOM, 2, "[To:100]AI係さん\n今の依頼", 1001)
      api.say(CW_ROOM, 100, "Bot の発言", 1001)
      await cw.poll()
      await cw.poll() // 同じ秒に届いた発言を取りこぼさないよう、もう一度だけ取得する
      await cw.poll()
      expect(api.gets()).toBe(2)
      await Bun.sleep(0)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toContain("今の依頼")
      expect(prompts[0]).not.toContain("停止中の依頼")
      expect((await relay.fetchMessages("chatwork:r7000")).map((m) => m.id)).toEqual([old, now])
      // DM は相手の ID をルームとし、メンションなしで渡す
      api.say(CW_DM, 1, "こんにちは", 1002)
      await cw.poll()
      await Bun.sleep(0)
      expect((await relay.fetchMessages("chatwork:u1")).map((m) => m.text)).toEqual(["こんにちは"])
      expect(prompts[1]).toContain('chat_id="chatwork:u1"')
      // 起動後に現れたグループチャットは、Bot が追加されたもの。ペアリングのコードを投稿する
      api.join(7002, "新しいルーム")
      await cw.poll()
      await Bun.sleep(50)
      expect(api.sent.at(-1)).toMatchObject({ kind: "message", room: 7002, body: expect.stringContaining("relay pair") })
    } finally {
      void api.server.stop()
    }
  })

  test("返信の記法を付けて送り、DM はコンタクトからルームを探す", async () => {
    const { api, cw } = await setup()
    try {
      const id = api.say(CW_ROOM, 2, "[To:100] 依頼", 1001)
      await cw.poll()
      await cw.send("chatwork:r7000", "どうぞ", { replyTo: id })
      await cw.sendApproval("chatwork:u1", "許可：yes abcde", "abcde")
      expect(api.sent).toEqual([
        { kind: "message", room: 7000, body: `[rp aid=2 to=7000-${id}]\nどうぞ` },
        { kind: "message", room: 7001, body: "許可：yes abcde" },
      ])
      await expect(cw.send("chatwork:u9", "x")).rejects.toThrow("ダイレクトチャットが見つかりません")
    } finally {
      void api.server.stop()
    }
  })

  test("ファイルには本文を添え、長い本文は分けて送る。添付は取得用の URL から取る", async () => {
    const { api, cw } = await setup()
    try {
      writeFileSync(join(dir, "a.pdf"), "x")
      writeFileSync(join(dir, "b.csv"), "y")
      await cw.send("chatwork:r7000", "資料です", { files: [join(dir, "a.pdf"), join(dir, "b.csv")] })
      expect(api.sent).toMatchObject([
        { kind: "file", room: 7000, body: "資料です", file: "a.pdf" },
        { kind: "file", room: 7000, body: "", file: "b.csv" },
      ])
      const long = `${"あ".repeat(60000)}\n\n${"い".repeat(10000)}`
      expect(await cw.send("chatwork:r7000", long)).toHaveLength(2)
      expect(api.sent.slice(2).map((s) => s.body.length)).toEqual([60000, 10000])
      api.addFile("9", "a.txt", "hi")
      const id = api.say(CW_ROOM, 2, "[info][title][dtext:file_uploaded][/title][download:9]a.txt (2 B)[/download][/info]", 1003)
      await cw.poll()
      const [path] = await cw.download("chatwork:r7000", id, join(dir, "inbox"))
      expect(readFileSync(path!, "utf8")).toBe("hi")
      expect(path).toEndWith(".txt")
    } finally {
      void api.server.stop()
    }
  })
})

describe("discord", () => {
  const ALICE_D = "discord:u1"

  async function setup() {
    const d = fakeDiscord()
    access.save({ allowFrom: [ALICE_D], rooms: { "discord:c100": { requireMention: true, allowFrom: [] } }, pending: {} })
    const relay = new Relay(access, quiet, dir, NO_WAIT)
    const prompts: string[] = []
    relay.attach({ prompt: async (t) => void prompts.push(t) })
    const dc = new DiscordConnector({ token: "t" }, relay, quiet, d.client, () => 1_000_000)
    relay.addConnector(dc)
    await dc.start()
    const dev = d.channel("100", { name: "開発" })
    const thread = d.channel("200", { name: "調査", parentId: "100" })
    return { d, relay, dc, prompts, dev, thread }
  }

  test("メンションは Bot・Bot 専用のロール・Bot の発言への返信だけ。スレッドは親の登録で受け、DM は相手の ID をルームにする", async () => {
    const { d, relay, dc, prompts, dev, thread } = await setup()
    await dc.handleMessage(d.say(dev, "1", `<@${BOT_ID}> 調べて`, { users: [BOT_ID] }))
    await dc.handleMessage(d.say(dev, "2", "@everyone お知らせ", { everyone: true }))
    await dc.handleMessage(d.say(dev, "2", `<@&${BOT_ROLE}> 頼む`, { roles: { [BOT_ROLE]: "AI係" } }))
    await dc.handleMessage(d.say(dev, "2", "<@&951> 営業へ", { roles: { "951": "営業" } }))
    const [mine] = await dc.send("discord:c100", "Bot の発言")
    await dc.handleMessage(d.say(dev, "2", "ありがとう", { replyTo: mine }))
    await dc.handleMessage(d.say(dev, BOT_ID, "自分の発言"))
    await dc.handleMessage(d.say(thread, "1", `<@${BOT_ID}> スレッドで`, { users: [BOT_ID] }))
    await dc.handleMessage(d.say(d.channel("dm-1", { dm: true }), "1", "DM です"))
    await Bun.sleep(0)
    const all = prompts.join("\n")
    for (const t of ["調べて", "頼む", "ありがとう", "スレッドで", "DM です"]) expect(all).toContain(t)
    expect(all).not.toContain("お知らせ")
    expect(all).not.toContain("営業へ")
    expect(all).toContain('chat_id="discord:c100/200" chat="#開発 › 調査"')
    expect(all).toContain('chat_id="discord:u1"')
    expect(d.typing).toContain("100")
    // 受け取りの合図（ADR 0012）は、エージェントに渡したメンションにだけ付ける
    expect(d.sent.filter((s) => s.content === "react:👀")).toHaveLength(5)
    // 渡さない発言も、記録には残る（Discord は履歴を読むので、fetch_messages は Discord から）
    expect((await relay.fetchMessages("discord:c100")).map((m) => m.text)).toContain("@everyone お知らせ")
  })

  test("未登録のチャンネルのスレッドで話しかけられたら、スレッドに親を登録するコードを返す", async () => {
    const { d, dc } = await setup()
    d.channel("300")
    const t = d.channel("301", { parentId: "300" })
    await dc.handleMessage(d.say(t, "2", `<@${BOT_ID}> はじめまして`, { users: [BOT_ID] }))
    await Bun.sleep(0)
    expect(d.sent.at(-1)).toMatchObject({ channel: "301", content: expect.stringContaining("relay pair") })
    expect(Object.values(access.load().pending)[0]).toMatchObject({ kind: "room", target: "discord:c300" })
  })

  test("長い本文は分けて送り、ファイルと返信は 1 通目に付ける。ほかのチャンネルのスレッドには送らない", async () => {
    const { d, dc } = await setup()
    writeFileSync(join(dir, "a.png"), "x")
    const ids = await dc.send("discord:c100", `${"あ".repeat(1500)}\n\n${"い".repeat(1500)}`, { replyTo: "42", files: [join(dir, "a.png")] })
    expect(ids).toHaveLength(2)
    expect(d.sent.map((s) => [s.content?.length, s.files?.length, s.reply?.messageReference])).toEqual([
      [1500, 1, "42"],
      [1500, 0, undefined],
    ])
    d.channel("999", { parentId: "300" })
    await expect(dc.send("discord:c100/999", "x")).rejects.toThrow("送れません")
  })

  test("承認の依頼はボタン付きで DM に送り、許可リストの人の押下だけを受け付ける", async () => {
    const { d, relay, dc: conn } = await setup()
    const verdict = relay.requestPermission({ title: "Bash", input: "ls" })
    await Bun.sleep(5)
    const req = d.sent.at(-1)!
    expect(req.channel).toBe("dm-1")
    expect(req.components).toHaveLength(1)
    const id = /yes ([a-km-z]{5})/.exec(req.content ?? "")![1]!
    const bob = d.press("2", `perm:allow:${id}`)
    await conn.handleInteraction(bob.interaction)
    expect(bob.replies).toMatchObject([{ reply: { content: expect.stringContaining("見つからない") } }])
    const alice = d.press("1", `perm:deny:${id}`, req.content)
    await conn.handleInteraction(alice.interaction)
    expect(await verdict).toBe("deny")
    expect(alice.replies).toMatchObject([{ update: { components: [], content: expect.stringContaining("❌ 拒否しました") } }])
  })

  test("ハーネスが「常に許可」を示した依頼には、常に許可のボタンを付ける", async () => {
    const { d, relay, dc: conn } = await setup()
    const verdict = relay.requestPermission({ title: "mcp__x", input: "{}", always: "Yes, and don't ask again for x" })
    await Bun.sleep(5)
    const req = d.sent.at(-1)!
    const ids = JSON.stringify(req.components).match(/perm:[a-z]+:[a-km-z]{5}/g)
    expect(ids?.map((x) => x.split(":")[1])).toEqual(["allow", "always", "deny"])
    const alice = d.press("1", ids![1]!, req.content)
    await conn.handleInteraction(alice.interaction)
    expect(await verdict).toBe("always")
    expect(alice.replies).toMatchObject([{ update: { content: expect.stringContaining("✅ 常に許可しました") } }])
  })

  test("リアクションは付けられ、編集は Bot が送った発言だけ", async () => {
    const { d, dc, dev } = await setup()
    const [mine] = await dc.send("discord:c100", "途中経過")
    const theirs = d.say(dev, "1", "人の発言")
    await dc.react("discord:c100", theirs.id, "👀")
    await dc.edit("discord:c100", mine!, "完了")
    await expect(dc.edit("discord:c100", theirs.id, "x")).rejects.toThrow("Bot が送った発言だけ")
    expect(d.sent.slice(1).map((x) => x.content)).toEqual(["react:👀", "edit:完了"])
  })

  test("登録したチャンネルの発言からスレッドを作り、その chat_id で reply できる。スレッドがあれば作らずに返す", async () => {
    const { d, relay, dev, thread } = await setup()
    const asked = d.say(dev, "1", "調べて")
    const room = await relay.createThread("discord:c100", asked.id, `${"調査".repeat(60)}\n続き`)
    expect(room).toBe(`discord:c100/${asked.id}`)
    expect(d.threads).toEqual([{ message: asked.id, name: "調査".repeat(50), autoArchiveDuration: 1440 }])
    await relay.reply(room, "スレッドで返します")
    expect(d.sent.at(-1)).toMatchObject({ channel: asked.id, content: "スレッドで返します" })
    expect(await relay.createThread("discord:c100", asked.id, "もう一度")).toBe(room)
    expect(d.threads).toHaveLength(1)

    // スレッドの中、DM、登録していないチャンネルでは作らない
    const inThread = d.say(thread, "1", "スレッドの中")
    await expect(relay.createThread("discord:c100/200", inThread.id, "x")).rejects.toThrow("チャンネルの発言からだけ")
    await expect(relay.createThread("discord:u1", "1", "x")).rejects.toThrow("チャンネルの発言からだけ")
    const other = d.say(d.channel("300"), "1", "未登録")
    await expect(relay.createThread("discord:c300", other.id, "x")).rejects.toThrow("登録されていません")
    await expect(relay.createThread("discord:c100", asked.id, " \n ")).rejects.toThrow("名前が空")
    expect(d.threads).toHaveLength(1)
  })

  test("メンションとチャンネルの記法を名前にし、Bot へのメンションは取り除く", () => {
    const msg = {
      content: `<@${BOT_ID}> <@2> と <@&951> は <#100> へ <@3>`,
      mentions: { users: new Map([["2", { displayName: "ボブ" }]]), members: null, roles: new Map([["951", { name: "営業" }]]), channels: new Map([["100", { name: "開発" }]]) },
    } as unknown as Parameters<typeof renderContent>[0]
    expect(renderContent(msg, BOT_ID, BOT_ROLE)).toBe("@ボブ と @営業 は #開発 へ <@3>")
  })
})

describe("作業ディレクトリ", () => {
  test("独立した git リポジトリにする", () => {
    const ws = join(dir, "ws")
    initWorkspace(ws)
    expect(existsSync(join(ws, ".git"))).toBe(true)
  })

  test("git init に失敗したら、または git が無ければ起動しない", () => {
    expect(() => initWorkspace(join(dir, "ws"), "false")).toThrow("起動しません")
    expect(() => initWorkspace(join(dir, "ws"), "/nonexistent/git")).toThrow("起動しません")
  })

  test("中継の置き場（.relay/）に届いたファイルは、管理者の git リポジトリでも未追跡にならない", () => {
    const ws = join(dir, "admin-repo")
    mkdirSync(ws)
    expect(Bun.spawnSync(["git", "init", "-q", ws]).success).toBe(true)
    const inbox = join(relayDir(ws), "inbox")
    mkdirSync(inbox)
    writeFileSync(join(inbox, "photo.png"), "x")
    const status = Bun.spawnSync(["git", "-C", ws, "status", "--porcelain", "--untracked-files=all"]).stdout.toString()
    expect(status).toBe("")
    // 中身の違う（空の）.gitignore があっても、書き直して無視させる
    writeFileSync(join(ws, ".relay", ".gitignore"), "")
    relayDir(ws)
    expect(Bun.spawnSync(["git", "-C", ws, "status", "--porcelain", "--untracked-files=all"]).stdout.toString()).toBe("")
  })

  test("中継の置き場（.relay/）やその中がリンクでも、リンク先には書かず、消さない", () => {
    for (const link of [".relay", ".relay/inbox"]) {
      const ws = mkdtempSync(join(dir, "ws-"))
      mkdirSync(join(ws, ".relay"), { recursive: true })
      if (link === ".relay") rmSync(join(ws, ".relay"), { recursive: true })
      mkdirSync(join(ws, "target"))
      symlinkSync(join(ws, "target"), join(ws, link))
      expect(() => relayDir(ws)).toThrow("シンボリックリンク")
      expect(existsSync(join(ws, "target", ".gitignore"))).toBe(false)
    }
    // .gitignore がシンボリックリンクやハードリンクでも、リンク先の中身は変えず、.relay/ の中に作り直す
    for (const make of [symlinkSync, linkSync]) {
      const ws = mkdtempSync(join(dir, "ws-"))
      mkdirSync(join(ws, ".relay"))
      writeFileSync(join(ws, ".gitignore"), "admin\n")
      make(join(ws, ".gitignore"), join(ws, ".relay", ".gitignore"))
      relayDir(ws)
      expect(readFileSync(join(ws, ".gitignore"), "utf8")).toBe("admin\n")
      expect(readFileSync(join(ws, ".relay", ".gitignore"), "utf8")).toBe("*\n")
    }
  })

  test("指定がなければ <home>/workspace を作り、指定があればそのディレクトリを git init せずに使う", () => {
    const home = join(dir, "home")
    expect(resolveWorkspace({}, home, [home])).toEqual({ path: join(home, "workspace"), specified: false })
    expect(existsSync(join(home, "workspace", ".git"))).toBe(true)

    const mine = join(dir, "mine")
    mkdirSync(mine)
    symlinkSync(mine, join(dir, "link"))
    // 実パスにする
    expect(resolveWorkspace({ RELAY_WORKSPACE: join(dir, "link") }, home, [home])).toEqual({ path: realpathSync(mine), specified: true })
    expect(existsSync(join(mine, ".git"))).toBe(false)
  })

  test("指定したディレクトリがないか、中継のデータか秘密情報の置き場を含むなら、起動しない", () => {
    const home = join(dir, "relay", "home")
    const secrets = join(dir, "secrets")
    mkdirSync(secrets)
    writeFileSync(join(dir, "file"), "")
    const ws = (w: string) => () => resolveWorkspace({ RELAY_WORKSPACE: w }, home, [home, secrets])
    expect(ws(join(dir, "nothing"))).toThrow("ディレクトリがありません")
    expect(ws(join(dir, "file"))).toThrow("ディレクトリがありません")
    expect(existsSync(join(dir, "nothing"))).toBe(false)
    // まだない RELAY_HOME も含めない
    mkdirSync(join(dir, "relay"))
    expect(ws(join(dir, "relay"))).toThrow("含むため")
    expect(ws(secrets)).toThrow("含むため")
    expect(ws(dir)).toThrow("含むため")
    mkdirSync(join(dir, "..secrets-like"))
    expect(resolveWorkspace({ RELAY_WORKSPACE: join(dir, "..secrets-like") }, home, [home, secrets]).specified).toBe(true)
  })
})

describe("ハーネスの設定の読み込み", () => {
  const NONE = { inheritSettings: false, memory: false }

  test("決めた値だけを受け付け、空の値は指定なしとして扱う", () => {
    expect(harnessOptionsFromEnv({})).toEqual(NONE)
    expect(harnessOptionsFromEnv({ RELAY_HARNESS_SETTINGS: "", RELAY_HARNESS_MEMORY: "" })).toEqual(NONE)
    expect(harnessOptionsFromEnv({ RELAY_HARNESS_SETTINGS: "default", RELAY_HARNESS_MEMORY: "1" })).toEqual({ inheritSettings: true, memory: true })
    expect(() => harnessOptionsFromEnv({ RELAY_HARNESS_SETTINGS: "true" })).toThrow("RELAY_HARNESS_SETTINGS に指定できるのは default だけ")
    expect(() => harnessOptionsFromEnv({ RELAY_HARNESS_MEMORY: "yes" })).toThrow("RELAY_HARNESS_MEMORY に指定できるのは 1 だけ")
  })

  test("指定がなければ、ユーザー設定・CLAUDE.md・自動メモリを読ませない。指定しても、権限モードと mcp__chat の許可は外さない", () => {
    const permissions = { defaultMode: "default", allow: ["mcp__chat"] }
    expect(claudeOptions(NONE)).toEqual({
      settingSources: ["project", "local"],
      settings: { claudeMdExcludes: ["**/AGENTS.md", "**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"], autoMemoryEnabled: false, permissions },
    })
    expect(claudeOptions({ inheritSettings: true, memory: false })).toEqual({ settings: { autoMemoryEnabled: false, permissions } })
    expect(claudeOptions({ inheritSettings: false, memory: true })).toEqual({
      settingSources: ["project", "local"],
      settings: { claudeMdExcludes: ["**/AGENTS.md", "**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"], autoMemoryEnabled: true, permissions },
    })
    expect(claudeOptions({ inheritSettings: true, memory: true })).toEqual({ settings: { autoMemoryEnabled: true, permissions } })
  })

  test("opencode は、指定した作業ディレクトリにある管理者の設定を上書きしない", () => {
    const env = { RELAY_ALLOW_UNSAFE_HARNESS: "1" }
    const mcp = { url: "http://127.0.0.1/mcp", token: "t" }
    const infos: string[] = []
    const log = { info: (m: string) => void infos.push(m), error: () => {} }
    const open = (cwd: string, specified: boolean, opts = NONE) => () => harnessConfig("opencode", cwd, mcp, opts, log, specified, env)

    // 中継専用の作業ディレクトリでは、今までどおり書く
    writeFileSync(join(dir, "opencode.json"), "{}")
    open(dir, false)()
    const written = readFileSync(join(dir, "opencode.json"), "utf8")
    expect(written).toContain('"chat_*"')
    // 中継が書いたものと同じなら、指定した作業ディレクトリでも使う
    expect(open(dir, true, { inheritSettings: true, memory: false })).not.toThrow()
    expect(infos).toContain("RELAY_HARNESS_SETTINGS・RELAY_HARNESS_MEMORY は、opencode には効きません")
    writeFileSync(join(dir, "opencode.json"), "{}")
    expect(open(dir, true)).toThrow("上書きしません")
    expect(readFileSync(join(dir, "opencode.json"), "utf8")).toBe("{}")
    rmSync(join(dir, "opencode.json"))
    writeFileSync(join(dir, "opencode.jsonc"), "{}")
    expect(open(dir, true)).toThrow("opencode.jsonc")
  })
})

test("ハーネスのログは、上限を超えそうになったら .1 に移して新しく始める", () => {
  const p = join(dir, "h.log")
  const f = new RotatingFile(p, 10)
  f.write(Buffer.from("123456"))
  f.write(Buffer.from("7890"))
  f.write(Buffer.from("abc"))
  f.close()
  expect(readFileSync(`${p}.1`, "utf8")).toBe("1234567890")
  expect(readFileSync(p, "utf8")).toBe("abc")
})
