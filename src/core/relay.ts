// 中核（ADR 0006）。コネクターから受けた発言を、ルームの登録と送信者の許可で絞って記録し、
// セッションにまとめて渡す。チャット用ツール（MCP）からの送信と、実行承認の中継も担当する。

import { randomInt } from "node:crypto"
import { realpathSync, statSync } from "node:fs"
import { basename, isAbsolute, relative, resolve, sep } from "node:path"
import { AccessStore, canSendTo, serviceOf, type GateResult, type ReceiveMode } from "./access.ts"
import { INSTRUCTIONS } from "./instructions.ts"

type LogFn = (msg: string, extra?: Record<string, unknown>) => void
/** info は通常の通知、error は失敗 */
export type Log = { info: LogFn; error: LogFn }

export type Attachment = { name: string; type: string; size?: number }

export type ChatMessage = {
  id: string
  room: string
  sender: string
  senderName?: string
  text: string
  ts: number
  attachments: Attachment[]
  fromMe?: boolean
}

export type Incoming = ChatMessage & {
  isDM: boolean
  mentioned: boolean
  /** 送信者以外の人への宛てがある（Inbound.toOthers。ADR 0028） */
  toOthers?: boolean
  /** 中継が止まっている間に届いた発言。登録したルームと許可した人の DM のものは記録だけして、エージェントには渡さない */
  stale?: boolean
}

/** コネクターが申告する、送れるものの上限。中核は、これで送る前に確認し、エージェントへの案内を組み立てる */
export type Capabilities = {
  /** 送れるファイル。送れなければ書かない */
  files?: {
    /** 送れる種類（案内に書く。例：「JPEG と PNG の画像」）。種類を問わなければ書かない */
    kinds?: string
    maxBytes: number
    /** 1 回に送れる数 */
    maxCount: number
  }
  /** 本文の 1 通の上限（文字数）と、超えたときに分けて送る通数の上限（1 なら分けずに切り詰める） */
  text: { max: number; parts: number }
}

/** コネクターによっては使えない操作（Connector の省略できるメソッド） */
export type OptionalOperation = "react" | "edit" | "history" | "createThread"

/** receive の結果。acknowledge なら、コネクターが受け取りの合図を出す（ADR 0012） */
export type ReceiveResult = GateResult & { acknowledge?: boolean }

/** 中継の HTTP サーバーに追加するルート（Webhook など）。中継が 1 つのサーバーにまとめて開く */
export type Routes = Bun.Serve.Routes<undefined, string>

/** チャットサービスごとのコネクター */
export interface Connector {
  /** ID の先頭（line、chatwork など） */
  readonly service: string
  /** 案内に出すサービスの名前 */
  readonly label: string
  readonly capabilities: Capabilities
  /**
   * 「親/子」の ID（Discord のスレッドなど）を使うか。使うコネクターは、子が本当にその親の中にあるかを、送るときに確認する
   * （中核は、子の ID を親の登録で通すため）。使わないコネクターへは、その形の ID で送らない
   */
  readonly nestedRooms?: boolean
  /** HTTP のエンドポイントが必要なら、そのルート */
  readonly routes?: Routes
  /** 受け取りを始める（ポーリング、常時接続など）。エンドポイントだけで受けるなら、何もしなくてよい */
  start(): Promise<void>
  stop(): void
  /** ルームへ送る。files は中継が確認した、作業ディレクトリの中のファイルの実パス。送ったメッセージの ID を返す */
  send(room: string, text: string, opts?: { replyTo?: string; files?: string[] }): Promise<string[]>
  /** 承認者の DM へ、実行承認の依頼を送る */
  sendApproval(user: string, text: string, requestId: string, opts?: { always?: boolean }): Promise<void>
  /**
   * 直前の発言への返事として、短い案内を送る（ペアリングのコードなど）。送れる手段がないときは何もせず、false を返す。
   * push は、返事として送れないとき、通数を使って送ってよいこと。通数がルームの人数分になるところ（LINE のグループ）では、使わない（ADR 0024）
   */
  notice(room: string, text: string, opts?: { push?: boolean }): Promise<boolean>
  /** 添付をローカルに取得し、パスを返す */
  download(room: string, messageId: string, dir: string): Promise<string[]>
  roomName(room: string): Promise<string | undefined>
  react?(room: string, messageId: string, emoji: string): Promise<void>
  edit?(room: string, messageId: string, text: string): Promise<void>
  /** ルームの最近の発言を、サービスの履歴から古い順に読む。なければ、中継の記録を使う */
  history?(room: string, limit: number): Promise<ChatMessage[]>
  /** ルームの発言からスレッドを作り、スレッドのルームの ID（親/子）を返す。その発言にスレッドがあれば、それを返す */
  createThread?(room: string, messageId: string, name: string): Promise<string>
}

/** 環境変数（秘密情報）からコネクターを作る。秘密情報がなければ undefined */
export type ConnectorFactory = (env: Record<string, string | undefined>, deps: ConnectorDeps) => Connector | undefined

/** コネクターを作るときに渡すもの */
export type ConnectorDeps = {
  relay: Relay
  log: Log
  /** 中継のデータの置き場（RELAY_HOME）。コネクターは、この下に自分のファイルを置ける */
  home: string
}

/** 発言を渡す先のセッション（ACP のハーネス）。prompt はターンが終わると解決する */
export interface Session {
  prompt(text: string): Promise<void>
  /**
   * 作業中のターンに発言を差し込む（ADR 0018）。ハーネスが対応していなければ持たない。
   * 差し込めたら true。ターンがすでに終わっていて差し込めなかったら false（発言は渡っていない）
   */
  steer?(text: string): Promise<boolean>
}

/**
 * always は、ハーネスが示した「常に許可」の範囲（選択肢の名前）。示されていなければ書かない。
 * agentText は、そのターンでエージェントが書いた文。承認依頼の送り先を推すのに使う（ADR 0026）
 */
export type PermissionRequest = { title: string; input: string; always?: string; agentText?: string; requireFullDisplay?: true }

/**
 * 送り先を推すときに渡す、そのターンの発言。sender は ID（推した結果を戻すのにだけ使い、外へは送らない）。
 * name は表示名、room はルームの名前（DM なら「DM」）で、なければ空。ID では補わない
 */
export type AttributionMessage = { sender: string; name: string; room: string; mentioned: boolean; text: string }
export type AttributionQuery = { title: string; input: string; agentText: string; messages: AttributionMessage[] }
/** 推した依頼者と、その確率。下限に届かないなど、推せなければ undefined */
export type Attributor = (q: AttributionQuery) => Promise<{ sender: string; probability: number } | undefined>
/**
 * 他人宛ての判定（ADR 0029）に渡す発言。sender は、同じ人に同じ名前を付けるのにだけ使い、外へは送らない。
 * fromMe は Bot の発言。name は表示名で、なければ空
 */
export type ScreenMessage = { sender: string; name: string; fromMe: boolean; text: string }
/** service はサービスの名前、room はルームの名前（なければ空）。recent は、同じルームの直前の発言（古い順） */
export type ScreenQuery = { service: string; room: string; recent: ScreenMessage[]; message: ScreenMessage }
/** drop なら、他人宛てとして外す。probabilities はログに書く。判定できなければ undefined（渡す） */
export type Screener = (q: ScreenQuery) => Promise<{ drop: boolean; probabilities: Record<string, number> } | undefined>
/** always は「常に許可」（ADR 0015） */
export type Verdict = "allow" | "always" | "deny"

// 承認の返事。ID は 5 文字で、l（1 と紛らわしい）は使わない
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no|always)\s+([a-km-z]{5})\s*$/i
const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000
/** 承認依頼の束（ADR 0014）。最後の依頼からこの時間、次の依頼が来なければ送る。最初の依頼からは最大 maxMs 待つ */
const BATCHING = { quietMs: 1000, maxMs: 3000 }
/** 1 つの束に入れる依頼の数。文面の長さでも分ける（approvalMax） */
const MAX_BATCH = 5
/** 「常に許可」の範囲は省略せずに見せる。これより長ければ、「常に許可」を出さない */
const MAX_ALWAYS_SCOPE = 200
/** 1 件だけの依頼の題名は、これより長ければ省く（Claude Code の Bash では、題名がコマンドそのもの） */
const MAX_SINGLE_TITLE = 200
const MAX_BATCH_TITLE = 100
const MAX_BATCH_INPUT = 200
/** 承認依頼の文面の上限から差し引く分。送り直すときに前に足す文と、Discord で答えたあとに足す結果が入るようにする */
const APPROVAL_MARGIN = 50
/** コネクターの本文の上限の下限。依頼 1 件の題名・答え方・「常に許可」の範囲を省かずに、承認依頼の文面に収めるため */
const MIN_TEXT = 1000
const RECORD_LIMIT = 200
/**
 * ターンの知らせ（ADR 0024）。メンションのあったルームへ、種類ごとに 1 回まで出す。文は固定で、エラーの中身と会話の中身は出さない。
 * failed：session/prompt が失敗した（ハーネスの異常終了を含む）。approval：承認依頼に答えがないまま時間がたった。
 * slow：返事もターンの終わりもないまま時間がたった。silent：返事を送らないままターンが終わった
 */
export const TURN_NOTICES = {
  failed: "今は不調で返事ができません。記録して調べています。",
  approval: "実行の承認を待っているため、作業が止まっています。",
  slow: "時間がかかっています。止まっている可能性もあります。",
  silent: "返事を送らないまま、作業を終えました。",
} as const
type TurnNoticeKind = keyof typeof TURN_NOTICES
/** 知らせを出すまでの時間。approval は承認依頼を送ってから、slow はルームの発言を渡してから */
type NoticeTiming = { approvalMs: number; slowMs: number }
const NOTICE_TIMING: NoticeTiming = { approvalMs: 10 * 60 * 1000, slowMs: 20 * 60 * 1000 }

/** 管理者が環境変数で変える、知らせを出すまでの時間（分）。決めた範囲の整数以外は、書き間違いとして起動しない */
export function noticeTimingFromEnv(env: Record<string, string | undefined>): NoticeTiming {
  return {
    // 承認依頼は PERMISSION_TIMEOUT_MS で拒否になるので、それより前に知らせる
    approvalMs: minutes(env, "RELAY_APPROVAL_NOTICE_MIN", NOTICE_TIMING.approvalMs, PERMISSION_TIMEOUT_MS / 60_000 - 1),
    slowMs: minutes(env, "RELAY_SLOW_NOTICE_MIN", NOTICE_TIMING.slowMs, 24 * 60),
  }
}

function minutes(env: Record<string, string | undefined>, name: string, fallback: number, max: number): number {
  const v = env[name]
  if (!v) return fallback
  const n = Number(v)
  if (!/^\d+$/.test(v) || n < 1 || n > max) throw new Error(`${name} に指定できるのは 1〜${max} の整数（分）です（今は ${JSON.stringify(v)}）`)
  return n * 60_000
}

/** ターンに渡した発言のルームごとの状態 */
type TurnRoom = { mentioned: boolean; replied: boolean; notified: Set<TurnNoticeKind>; slow?: Timer }

function stopSlowTimers(turn: Map<string, TurnRoom>): void {
  for (const r of turn.values()) clearTimeout(r.slow)
}

/**
 * 承認依頼の送り先（ADR 0026）。to があれば、その承認者だけに送る。Jev で決めたときは、その確率（probability）がある。
 * to がなければ全員に送り、文面に、依頼が届いた時点でターンに渡していた発言の送り手（senders）を並べる
 */
type Route = { to?: string; probability?: number; senders: TurnSender[] }
/** ターンに発言を渡した人。ルームごと。mentioned は、そのルームでメンションしたか */
type TurnSender = Pick<AttributionMessage, "room" | "sender" | "name" | "mentioned">

type PendingRequest = { id: string; req: PermissionRequest; resolve: (v: Verdict) => void; route: Route }
/** 承認依頼の束。送るまでは opened、送ったあとは id で答えられる。束の中の依頼は、送り先が同じ */
type Batch = { id: string; items: PendingRequest[]; opened: number; timeout: Timer; flush?: Timer; waiting?: Timer }

export class Relay {
  private readonly connectors = new Map<string, Connector>()
  /** 中継が受けた発言と送った発言の記録（メモリだけ）。どのサービスでも記録するが、fetch_messages で読むのは、履歴を読めないコネクターのときだけ */
  private readonly records = new Map<string, ChatMessage[]>()
  private readonly queue: Incoming[] = []
  /** 送った承認依頼の束（束の ID から） */
  private readonly batches = new Map<string, Batch>()
  /** まだ送っていない束 */
  private collecting?: Batch
  private session?: Session
  private running = false
  /** 作業中のターンを見ている run() を、発言が届いたことで起こす */
  private arrived?: () => void
  /** 差し込みに失敗したら、以後は使わない */
  private steerable = true
  private introduced = false
  /** 作業中のターンに渡した発言のルーム。ターンの知らせ（ADR 0024）に使う */
  private turn?: Map<string, TurnRoom>
  /** 作業中のターンに渡した発言。承認依頼の送り先を決めるのに使う（ADR 0026） */
  private turnMessages: Incoming[] = []
  /** 発言を渡すときに調べたルームの名前。承認依頼の文面に使う */
  private readonly roomNames = new Map<string, string | undefined>()
  /** 送っている途中の知らせ。中継が止まる前に待つ */
  private readonly sending = new Set<Promise<void>>()
  /** run() が動いていれば、その Promise */
  private runningTurns?: Promise<void>
  /** 待ち行列の発言のうち、他人宛ての判定（ADR 0029）を待っているもの。答えが true なら渡す */
  private readonly screening = new Map<Incoming, Promise<boolean>>()

  constructor(
    private readonly access: AccessStore,
    private readonly log: Log = { info: (m, e) => console.log(`relay: ${m}`, e ?? ""), error: (m, e) => console.error(`relay: ${m}`, e ?? "") },
    /** reply で送れるファイルの置き場所（作業ディレクトリ）。ない場合はファイルを送れない（ADR 0009） */
    private readonly workspace?: string,
    private readonly batching = BATCHING,
    private readonly timing = NOTICE_TIMING,
    /** 送り手が複数いるターンで、承認依頼の依頼者を推す（Jev。ADR 0026）。なければ全員に送る */
    private readonly attribute?: Attributor,
    /** 受信モードが「他人宛てを除く（Jev）」のルームで、他人宛てかを判定する（ADR 0029）。なければ「他人宛てを除く」と同じに動く */
    private readonly screen?: Screener,
  ) {}

  addConnector(c: Connector): void {
    if (c.capabilities.text.max < MIN_TEXT)
      throw new Error(`${c.label} の本文の上限（${c.capabilities.text.max} 字）では、承認依頼の文面が収まりません。${MIN_TEXT} 字以上にするか、approvalText を直してください`)
    this.connectors.set(c.service, c)
  }

  /** エージェントへの最初の案内。送れるものは、つながっているサービスの分だけ書く */
  instructions(): string {
    return INSTRUCTIONS.replace("{sending}", this.sendingGuide())
  }

  /** コネクターによっては使えない操作を、使えるサービスと使えないサービスに分ける（ツールの説明とエラーに書く。ADR 0013） */
  servicesFor(op: OptionalOperation): { supported: string[]; unsupported: string[] } {
    const r = { supported: [] as string[], unsupported: [] as string[] }
    for (const c of this.connectors.values()) (c[op] ? r.supported : r.unsupported).push(`${c.label}（${c.service}:）`)
    return r
  }

  /** サービスごとの、送れるファイルと本文の長さ */
  sendingGuide(): string {
    return [...this.connectors.values()].map((c) => `- ${c.label}（${c.service}:）：${describeCapabilities(c.capabilities)}`).join("\n")
  }

  attach(session: Session): void {
    this.session = session
    this.kick()
  }

  /** コネクターが受けた発言 */
  receive(m: Incoming): ReceiveResult {
    // 古い依頼の実行、古い承認の返事、ペアリングのコードを出さないよう、許可の判定（gate）を通さない
    if (m.stale) {
      if (!canSendTo(this.access.load(), m.room)) return { action: "drop" }
      this.record(m)
      return { action: "record" }
    }
    const r = this.access.gate(m)
    if (r.action === "pair") void this.pairingNotice(m.room, r.code, r.isResend)
    if (r.action === "record") {
      this.record(m)
      // 本文は書かない（ADR 0028）
      if (r.toOthers) this.log.info("他人宛ての発言を、エージェントに渡さずに記録しました", { room: m.room, reason: "structure" })
    }
    if (r.action !== "deliver") return r
    const p = PERMISSION_REPLY_RE.exec(m.text)
    if (m.isDM && p) {
      const word = p[1]!.toLowerCase()
      const ok = this.answer(m.sender, p[2]!.toLowerCase(), word === "always" ? "always" : word.startsWith("y") ? "allow" : "deny")
      void this.connector(m.room)
        ?.notice(m.room, ok ? "受け付けました" : "その依頼は見つからないか、すでに答えが出ています")
        .finally(() => ok && this.remindPending(m.sender))
      return r
    }
    // 判定には、この発言より前の、同じルームの発言を渡す
    if (r.screen && this.screen) this.screening.set(m, this.screenMessage(m, [...(this.records.get(m.room) ?? [])]))
    this.record(m)
    this.queue.push(m)
    this.kick()
    // 受信モードが「すべて」のルームの、メンションのない発言には出さない
    return { ...r, acknowledge: m.mentioned }
  }

  joined(room: string): void {
    const r = this.access.joined(room)
    if (r.action === "pair") void this.pairingNotice(room, r.code, r.isResend)
  }

  // ---- 実行承認の中継 ----

  requestPermission(req: PermissionRequest): Promise<Verdict> {
    const approvers = this.access.load().allowFrom
    if (approvers.length === 0) {
      this.log.error("実行承認を送れる人がいないため、拒否しました", { tool: req.title })
      return Promise.resolve("deny")
    }
    // 依頼が届いた時点の発言で決める。依頼のあとに届いた発言は、その依頼のきっかけになりえない
    const roomName = (m: Incoming) => (m.isDM ? "DM" : (this.roomNames.get(m.room) ?? ""))
    const messages = this.turnMessages.map((m) => ({ sender: m.sender, name: m.senderName ?? "", room: roomName(m), mentioned: m.mentioned, text: m.text }))
    // 承認者に見せる一覧では、名前がなければ ID を書く
    const senders = turnSenders(
      this.turnMessages.map((m) => ({ sender: m.sender, name: m.senderName ?? m.sender, room: roomName(m) || m.room, mentioned: m.mentioned })),
    )
    const users = new Set(messages.map((m) => m.sender))
    const candidates = [...users].filter((u) => approvers.includes(u))
    // 送り手が 1 人なら、その人が承認者のときだけ絞る（そうでなければ to はなく、全員に送る）
    if (users.size === 1) return this.enqueue(req, { to: candidates[0], senders })
    if (candidates.length === 0 || !this.attribute) return this.enqueue(req, { senders })
    // 送り手が複数いれば、依頼者を推す。推せなければ全員に送る。推した人が承認者でなければ、その束には全員が答えられる（canAnswer）
    return this.attribute({ title: req.title, input: req.input, agentText: req.agentText ?? "", messages })
      .catch((err) => {
        this.log.error("承認依頼の依頼者を推せませんでした", { error: String(err) })
        return undefined
      })
      .then((guess) => this.enqueue(req, { to: guess?.sender, probability: guess?.probability, senders }))
  }

  private enqueue(req: PermissionRequest, route: Route): Promise<Verdict> {
    const always = req.always && req.always.length <= MAX_ALWAYS_SCOPE ? req.always : undefined
    const normalized = req.requireFullDisplay
      ? { ...req, always, title: approvalLiteral(req.title), input: approvalLiteral(req.input) }
      : { ...req, always }
    if (normalized.requireFullDisplay) {
      const item = { req: normalized, id: ID_PLACEHOLDER, route }
      const max = MIN_TEXT - APPROVAL_MARGIN
      // 送り先の人が許可リストから外れると、出し直し時は全員向けの文面になる。
      if (
        approvalText([item], ID_PLACEHOLDER, max, false).length > max ||
        (route.to && approvalText([item], ID_PLACEHOLDER, max, true).length > max)
      ) {
        this.log.error("操作と対象をすべて表示できないため、実行を拒否しました", { tool: req.title })
        return Promise.resolve("deny")
      }
    }
    return new Promise<Verdict>((resolve) => {
      const pending = { req: normalized, resolve, route }
      if (normalized.requireFullDisplay && (normalized.title.length > MAX_BATCH_TITLE || normalized.input.length > MAX_BATCH_INPUT)) {
        // 束にすると全文が収まらない依頼は 1 件で送る。収集中の束はそのまま待つ。
        const b = this.newBatch()
        b.items.push({ id: this.newPermissionId(), ...pending })
        this.sendBatch(b)
        return
      }
      let b = this.collecting ?? this.openBatch()
      // 送り先が違えば、今の束を先に送る（ADR 0026）。
      // 足すと文面が上限を超えるときも同じ。コネクターが文面を切ると、依頼や「常に許可」の範囲が見えないまま、束全体に答えられてしまう（ADR 0015）。
      // 長さは全員への文面で測る。1 人への文面がそれより長く上限を超えたら、送るときに依頼ごとに分ける（sendBatchTo）
      const head = b.items[0]?.route
      if (head && (head.to !== route.to || approvalText([...b.items, { id: ID_PLACEHOLDER, ...pending }], ID_PLACEHOLDER, Infinity, false).length > this.approvalMax())) {
        clearTimeout(b.flush)
        this.sendBatch(b)
        b = this.openBatch()
      }
      b.items.push({ id: this.newPermissionId(), ...pending })
      clearTimeout(b.flush)
      if (b.items.length >= MAX_BATCH) return this.sendBatch(b)
      const wait = Math.min(this.batching.quietMs, b.opened + this.batching.maxMs - Date.now())
      b.flush = setTimeout(() => this.sendBatch(b), Math.max(0, wait))
    })
  }

  private newBatch(): Batch {
    const b: Batch = { id: "", items: [], opened: Date.now(), timeout: setTimeout(() => this.expire(b), PERMISSION_TIMEOUT_MS) }
    return b
  }

  private openBatch(): Batch {
    return this.collecting = this.newBatch()
  }

  private sendBatch(b: Batch): void {
    if (this.collecting === b) this.collecting = undefined
    // 依頼が 1 つなら、その依頼の ID をそのまま束の ID にする
    b.id = b.items.length === 1 ? b.items[0]!.id : this.newPermissionId()
    this.batches.set(b.id, b)
    b.waiting = setTimeout(() => this.noticeTurn("approval"), this.timing.approvalMs)
    const approvers = this.access.load().allowFrom
    for (const user of approvers) if (canAnswer(b, user, approvers)) this.sendBatchTo(user, b)
  }

  private sendBatchTo(user: string, b: Batch, lead = ""): void {
    const c = this.connector(user)
    if (!c) return
    const max = c.capabilities.text.max - APPROVAL_MARGIN
    const narrowed = b.items[0]!.route.to === user
    const text = approvalText(b.items, b.id, max, narrowed)
    // 束を組んだあとに、上限の短いサービスの承認者が足されると、束が収まらない。束全体への答えは出さず、依頼ごとの ID で 1 件ずつ送る
    const parts =
      text.length <= max ? [{ items: b.items, id: b.id, text }] : b.items.map((i) => ({ items: [i], id: i.id, text: approvalText([i], i.id, max, narrowed) }))
    for (const [n, p] of parts.entries()) {
      c.sendApproval(user, (n === 0 ? lead : "") + p.text, p.id, { always: p.items.every((i) => i.req.always) })
        .catch((err) => this.log.error("承認の依頼を送れませんでした", { user, error: String(err) }))
    }
  }

  /** 束を組むときの文面の上限。承認者のいるサービスのうち、本文の上限がいちばん短いものに合わせる */
  private approvalMax(): number {
    const limits = this.access.load().allowFrom.flatMap((u) => this.connector(u)?.capabilities.text.max ?? [])
    return Math.min(...limits) - APPROVAL_MARGIN
  }

  private expire(b: Batch): void {
    if (b.items.length === 0) return
    this.log.info("実行承認の返事がなく、拒否しました", { id: b.id })
    this.settle(b, b.items, "deny")
  }

  private settle(b: Batch, items: PendingRequest[], verdict: Verdict): void {
    // 「常に許可」が示されていない依頼には、今回だけの許可として答える
    for (const item of items) item.resolve(verdict === "always" && !item.req.always ? "allow" : verdict)
    b.items = b.items.filter((i) => !items.includes(i))
    if (b.items.length > 0) return
    clearTimeout(b.timeout)
    clearTimeout(b.waiting)
    this.batches.delete(b.id)
  }

  private newPermissionId(): string {
    let id: string
    do id = permissionId()
    while (this.batches.has(id) || [...this.batches.values(), this.collecting].some((b) => b?.items.some((i) => i.id === id)))
    return id
  }

  /** 承認者からの返事。id は束の ID（束のすべての依頼に答える）か、依頼の ID。許可リストの人でなければ受け付けない */
  answer(sender: string, id: string, verdict: Verdict): boolean {
    const approvers = this.access.load().allowFrom
    const whole = this.batches.get(id)
    if (whole) {
      if (!canAnswer(whole, sender, approvers)) return false
      this.settle(whole, whole.items, verdict)
      return true
    }
    for (const b of this.batches.values()) {
      const item = b.items.find((i) => i.id === id)
      if (item) {
        if (!canAnswer(b, sender, approvers)) return false
        this.settle(b, [item], verdict)
        return true
      }
    }
    return false
  }

  /** 答えを受け付けたあとに呼ぶ。答えていない束が残っていれば、いちばん古い束をその人へ出し直す */
  remindPending(user: string): void {
    // 答えてから呼ばれるまでのあいだに、許可リストから外れたかもしれない。ほかの人だけに送った束は出さない
    const approvers = this.access.load().allowFrom
    const pending = [...this.batches.values()].filter((b) => canAnswer(b, user, approvers))
    const oldest = pending[0]
    if (!oldest) return
    const left = pending.reduce((n, b) => n + b.items.length, 0)
    this.sendBatchTo(user, oldest, `答えていない依頼が残っています（残り ${left} 件）\n\n`)
  }

  // ---- チャット用ツール（MCP）から呼ばれる操作 ----

  async reply(room: string, text: string, replyTo?: string, files: string[] = []): Promise<string[]> {
    const c = this.allowedConnector(room)
    const paths = sendablePaths(files, this.workspace)
    checkFiles(c, paths)
    const ids = await c.send(room, text, { replyTo, files: paths })
    this.replied(room)
    const attachments = paths.map((p) => ({ name: basename(p), type: "file" }))
    this.record({ id: ids[0] ?? `sent-${Date.now()}`, room, sender: "me", text, ts: Date.now(), attachments, fromMe: true })
    return ids
  }

  async fetchMessages(room: string, limit = 20): Promise<ChatMessage[]> {
    const c = this.allowedConnector(room)
    const n = Math.min(Math.max(limit, 1), 100)
    if (c.history) return c.history(room, n)
    return (this.records.get(room) ?? []).slice(-n)
  }

  async download(room: string, messageId: string, dir: string): Promise<string[]> {
    return this.allowedConnector(room).download(room, messageId, dir)
  }

  async react(room: string, messageId: string, emoji: string): Promise<void> {
    const c = this.allowedConnector(room)
    if (!c.react) throw this.unsupported(c, "react", "リアクションを付けられません", "reply で伝えてください")
    await c.react(room, messageId, emoji)
  }

  async edit(room: string, messageId: string, text: string): Promise<void> {
    const c = this.allowedConnector(room)
    if (!c.edit) throw this.unsupported(c, "edit", "送った発言を編集できません", "新しく reply してください")
    await c.edit(room, messageId, text)
  }

  /** スレッドは親の登録を引き継ぐ（ADR 0011）ので、登録したルームの発言からだけ作る */
  async createThread(room: string, messageId: string, name: string): Promise<string> {
    const c = this.allowedConnector(room)
    if (!c.createThread) throw this.unsupported(c, "createThread", "スレッドを作れません", "そのまま reply してください")
    return c.createThread(room, messageId, name)
  }

  async listRooms(): Promise<{ chat_id: string; name?: string; kind: "room" | "dm"; receive?: ReceiveMode }[]> {
    const a = this.access.load()
    const rooms = await Promise.all(
      Object.entries(a.rooms).map(async ([room, p]) => ({ chat_id: room, name: await this.roomName(room), kind: "room" as const, receive: p.receive })),
    )
    return [...rooms, ...a.allowFrom.map((user) => ({ chat_id: user, kind: "dm" as const }))]
  }

  /** 他人宛てかを Jev で判定する。外すなら false。判定できなければ渡す（ADR 0029） */
  private async screenMessage(m: Incoming, recent: ChatMessage[]): Promise<boolean> {
    const toScreen = (x: ChatMessage): ScreenMessage => ({ sender: x.sender, name: x.senderName ?? "", fromMe: x.fromMe === true, text: x.text })
    const query = { service: this.connector(m.room)?.label ?? "", room: (await this.roomName(m.room)) ?? "", recent: recent.map(toScreen), message: toScreen(m) }
    const r = await this.screen!(query).catch((err) => {
      this.log.error("他人宛てかを判定できませんでした", { error: String(err) })
      return undefined
    })
    if (!r) return true
    // 本文は書かない。しきい値を確かめられるよう、渡した発言の確率も書く
    if (r.drop) this.log.info("他人宛ての発言を、エージェントに渡さずに記録しました", { room: m.room, reason: "jev", ...r.probabilities })
    else this.log.info("Jev で他人宛てでないと判定し、渡しました", { room: m.room, ...r.probabilities })
    return !r.drop
  }

  /**
   * 待ち行列の、今ある発言を取り出す。他人宛ての判定を待っている発言があれば、その答えを待ち、外す発言を除く。
   * 待つ間に届いた発言は残すので、発言の順番は変わらない
   */
  private async take(): Promise<Incoming[]> {
    const batch = this.queue.slice()
    const keep = await Promise.all(batch.map((m) => this.screening.get(m) ?? Promise.resolve(true)))
    this.queue.splice(0, batch.length)
    for (const m of batch) this.screening.delete(m)
    return batch.filter((_, i) => keep[i])
  }

  private kick(): void {
    this.arrived?.()
    if (this.running || !this.session || this.queue.length === 0) return
    this.running = true
    this.runningTurns = this.run()
  }

  private async run(): Promise<void> {
    try {
      while (this.session && this.queue.length > 0) {
        const batch = await this.take()
        if (batch.length === 0) continue
        const text = await this.render(batch)
        const turnRooms = new Map<string, TurnRoom>()
        this.turn = turnRooms
        this.delivered(turnRooms, batch)
        let failed = false
        const turn = this.session
          .prompt(text)
          .catch((err) => {
            failed = true
            this.log.error("セッションへの入力に失敗しました", { error: String(err) })
          })
          // 差し込みの結果を待つ間にターンが終わっても、時間のたった知らせを出さない
          .finally(() => stopSlowTimers(turnRooms))
        await this.steerUntil(this.session, turn, turnRooms)
        this.endTurn(turnRooms, failed)
      }
    } finally {
      this.running = false
    }
  }

  /**
   * ターンが終わるまで、届いた発言をそのターンに差し込む（ADR 0018）。
   * 差し込めないハーネスや、差し込めなかった発言は、ためておき、ターンが終わってからまとめて渡す。
   * 差し込みの結果を待つ間にターンが終わったら、次の発言は差し込まず、次のターンで渡す（#50）。
   * 差し込めた発言のルームは、rooms に足す
   */
  private async steerUntil(session: Session, turn: Promise<void>, rooms: Map<string, TurnRoom>): Promise<void> {
    const steer = session.steer?.bind(session)
    if (!steer || !this.steerable) return turn
    let done = false
    const ended = turn.then(() => {
      done = true
      return "ended" as const
    })
    for (;;) {
      if (done) return
      if (this.queue.length > 0) {
        const batch = await this.take()
        if (batch.length === 0) continue
        try {
          const text = await this.render(batch)
          if (!done && (await steer(text))) {
            this.delivered(rooms, batch)
            continue
          }
        } catch (err) {
          this.steerable = false
          this.log.error("作業中のターンへの差し込みに失敗しました。以後は、ターンが終わってから渡します", { error: String(err) })
        }
        // 渡せなかった発言は、あとから届いた発言より前に渡す
        this.queue.unshift(...batch)
        await turn
        return
      }
      const next = await Promise.race([ended, new Promise<"arrived">((r) => (this.arrived = () => r("arrived")))])
      this.arrived = undefined
      if (next === "ended") return
    }
  }

  async render(batch: Incoming[]): Promise<string> {
    const parts: string[] = []
    if (!this.introduced) {
      parts.push(this.instructions(), "")
      this.introduced = true
    }
    const names = new Map(await Promise.all([...new Set(batch.map((m) => m.room))].map(async (r) => [r, await this.roomName(r)] as const)))
    for (const [room, name] of names) this.roomNames.set(room, name)
    for (const m of batch) {
      const name = names.get(m.room)
      const attrs: Record<string, string> = {
        chat_id: m.room,
        ...(name ? { chat: name } : {}),
        message_id: m.id,
        user: m.senderName ?? m.sender,
        user_id: m.sender,
        ts: new Date(m.ts).toISOString(),
        ...(m.mentioned ? { mentioned: "true" } : {}),
      }
      if (m.attachments.length > 0) attrs.attachments = m.attachments.map(describeAttachment).join("; ")
      const attrText = Object.entries(attrs)
        .map(([k, v]) => `${k}="${escapeXml(v)}"`)
        .join(" ")
      parts.push(`<message ${attrText}>\n${escapeXml(m.text)}\n</message>`)
    }
    return parts.join("\n")
  }

  private record(m: ChatMessage): void {
    const list = this.records.get(m.room) ?? []
    list.push(m)
    if (list.length > RECORD_LIMIT) list.splice(0, list.length - RECORD_LIMIT)
    this.records.set(m.room, list)
  }

  private async pairingNotice(room: string, code: string, isResend: boolean): Promise<void> {
    const lead = isResend ? "まだ登録されていません" : "このルームは登録されていません"
    await this.connector(room)
      ?.notice(room, `${lead}。管理者が端末で次を実行すると登録されます。\n\nrelay pair ${code}`)
      .catch((err) => this.log.error("ペアリングのコードを送れませんでした", { error: String(err) }))
  }

  // ---- ターンの知らせ（ADR 0024） ----

  /** ターンに渡した発言のルームを足す。ルームに最初のメンションを渡してから slowMs、返事もターンの終わりもなければ、知らせる */
  private delivered(turn: Map<string, TurnRoom>, batch: Incoming[]): void {
    this.turnMessages.push(...batch)
    for (const m of batch) {
      const r = turn.get(m.room) ?? { mentioned: false, replied: false, notified: new Set() }
      turn.set(m.room, r)
      r.mentioned ||= m.mentioned
      if (r.mentioned) r.slow ??= setTimeout(() => this.noticeRoom(m.room, r, "slow"), this.timing.slowMs)
    }
  }

  /** そのターンで、ルームへ返事した */
  private replied(room: string): void {
    const r = this.turn?.get(room)
    if (r) r.replied = true
  }

  private endTurn(turn: Map<string, TurnRoom>, failed: boolean): void {
    // 時間のたった知らせを、次のターンに持ち越さない
    stopSlowTimers(turn)
    for (const [room, r] of turn) this.noticeRoom(room, r, failed ? "failed" : "silent")
    this.turn = undefined
    this.turnMessages = []
  }

  /** 作業中のターンのルームすべてに知らせる */
  private noticeTurn(kind: TurnNoticeKind): void {
    for (const [room, r] of this.turn ?? []) this.noticeRoom(room, r, kind)
  }

  /**
   * メンションのあったルームにだけ、種類ごとに 1 回まで知らせる。受信モードが「すべて」のルームの雑談では、だれも返事を待っていない。
   * 時間がかかっていることと、返事のない終わりは、そのターンにルームへ返事していれば知らせない
   */
  private noticeRoom(room: string, r: TurnRoom, kind: TurnNoticeKind): void {
    if (!r.mentioned || r.notified.has(kind)) return
    if ((kind === "slow" || kind === "silent") && r.replied) return
    r.notified.add(kind)
    const p = this.connector(room)
      ?.notice(room, TURN_NOTICES[kind], { push: true })
      .then(
        (sent) => (sent ? this.log.info("ルームに知らせました", { room, kind }) : this.log.info("ルームに知らせる手段がないため、知らせませんでした", { room, kind })),
        (err) => this.log.error("ルームに知らせられませんでした", { room, kind, error: String(err) }),
      )
    if (!p) return
    this.sending.add(p)
    void p.finally(() => this.sending.delete(p))
  }

  /**
   * 作業中のターンが終わり、知らせを送り終わるまで待つ（最大 timeoutMs）。ハーネスが落ちたとき、中継を止める前に呼ぶ。
   * ターンは、ハーネスとの接続が切れると失敗で終わる
   */
  async drain(timeoutMs: number): Promise<void> {
    let timer: Timer | undefined
    const timeout = new Promise<void>((r) => (timer = setTimeout(r, timeoutMs)))
    const settled = (async () => {
      await this.runningTurns
      await Promise.allSettled(this.sending)
    })()
    await Promise.race([settled, timeout])
    clearTimeout(timer)
  }

  private connector(id: string): Connector | undefined {
    return this.connectors.get(serviceOf(id))
  }

  private roomName(room: string): Promise<string | undefined> {
    return this.connector(room)?.roomName(room).catch(() => undefined) ?? Promise.resolve(undefined)
  }

  private unsupported(c: Connector, op: OptionalOperation, what: string, instead: string): Error {
    const { supported } = this.servicesFor(op)
    return new Error(`${c.label} では${what}${supported.length > 0 ? `（使えるのは ${supported.join("、")}）` : ""}。${instead}`)
  }

  private allowedConnector(room: string): Connector {
    const c = this.connector(room)
    if (!c) throw new Error(`知らないチャットサービスです: ${room}`)
    if (room.includes("/") && !c.nestedRooms) throw new Error(`${c.label} の ID の形が違います: ${room}`)
    if (!canSendTo(this.access.load(), room)) throw new Error(`${room} は登録されていません（list_rooms で送れるルームが分かります）`)
    return c
  }
}

/** 送るファイルを確認し、実パスを返す。作業ディレクトリの外（リンクで外を指すものも含む）は送らない（ADR 0009） */
export function sendablePaths(files: string[], workspace: string | undefined): string[] {
  if (files.length === 0) return []
  if (!workspace) throw new Error("ファイルは送れません")
  const root = realpathSync(workspace)
  return files.map((f) => {
    let real: string
    try {
      real = realpathSync(resolve(root, f))
    } catch {
      throw new Error(`ファイルが見つかりません: ${f}`)
    }
    const rel = relative(root, real)
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`作業ディレクトリの外のファイルは送れません: ${f}`)
    if (!statSync(real).isFile()) throw new Error(`ファイルではありません: ${f}`)
    return real
  })
}

/** コネクターが申告した上限で、送るファイルを確認する。送れないものがあれば、何も送らずにエラーにする */
function checkFiles(c: Connector, paths: string[]): void {
  if (paths.length === 0) return
  const f = c.capabilities.files
  if (!f) throw new Error(`${c.label} ではファイルを送れません`)
  if (paths.length > f.maxCount) throw new Error(`${c.label} で一度に送れるファイルは ${f.maxCount} 個までです`)
  for (const p of paths) {
    if (statSync(p).size > f.maxBytes) throw new Error(`${c.label} で送れるファイルは ${mb(f.maxBytes)} までです: ${basename(p)}`)
  }
}

function describeCapabilities(cap: Capabilities): string {
  const f = cap.files
  const files = f ? `ファイルは${f.kinds ? ` ${f.kinds}だけ` : "種類を問わず"}、1 個 ${mb(f.maxBytes)}・1 回 ${f.maxCount} 個まで。` : "ファイルは送れない。"
  const t = cap.text
  const text = t.parts > 1 ? `本文は 1 通 ${t.max} 字までで、超えると ${t.parts} 通まで分けて送る（残りは省略）。` : `本文は ${t.max} 字まで（超えた分は省略）。`
  return files + text
}

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)}MB`
}

function permissionId(): string {
  const letters = "abcdefghijkmnopqrstuvwxyz"
  return Array.from({ length: 5 }, () => letters[randomInt(letters.length)]).join("")
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function describeAttachment(a: Attachment): string {
  // 名前は送信者が決められる。区切り文字で枠を壊されないよう置き換える
  const name = a.name.replace(/[[\]\r\n;]/g, "_")
  return a.size === undefined ? `${name} (${a.type})` : `${name} (${a.type}, ${Math.ceil(a.size / 1024)}KB)`
}

/** 承認の対象を装飾・リンク・タグとして解釈させない。元の操作の文字は置き換えず、表示だけ変える。 */
function approvalLiteral(text: string): string {
  return text.replace(/[-!#&*+<=>@[\\\]^_`|~:\p{Cf}]/gu, ch => `\\u{${ch.codePointAt(0)!.toString(16)}}`)
}

/**
 * その人が束に答えられるか（ADR 0026）。許可リストの人で、束の送り先が 1 人ならその人。
 * 送り先の人が許可リストから外れたら、答えられる人がいなくならないよう、全員が答えられる
 */
function canAnswer(b: Batch, user: string, approvers: string[]): boolean {
  if (!approvers.includes(user)) return false
  const to = b.items[0]!.route.to
  return to === user || !approvers.some((a) => a === to)
}

/** ターンに発言を渡した人を、ルームごとに、渡した順に並べる。そのルームで 1 度でもメンションした人は、依頼者にする */
function turnSenders(messages: TurnSender[]): TurnSender[] {
  const senders = new Map<string, TurnSender>()
  for (const m of messages) {
    const key = JSON.stringify([m.room, m.sender])
    const s = senders.get(key) ?? { room: m.room, sender: m.sender, name: m.name, mentioned: false }
    s.mentioned ||= m.mentioned
    senders.set(key, s)
  }
  return [...senders.values()]
}

/** 承認依頼の文面に並べる名前の上限と、発言した人の一覧の上限 */
const MAX_NAME = 40
const MAX_SENDERS_TEXT = 300

/**
 * 束の送り先の決め方を、受け取った人に示す欄（ADR 0026）。その人だけに送ったならそう書き、全員に送ったなら、ターンに発言を渡した人を並べる。
 * ターンの外で届いた依頼には書かない
 */
function routeLines(pending: Pick<PendingRequest, "route">[], narrowed: boolean): string[] {
  if (narrowed) {
    // Jev で決めた依頼があれば、そのうちいちばん低い確率を書く
    const p = pending.flatMap((i) => i.route.probability ?? [])
    const by = p.length === 0 ? "" : `Jev の判定（確率 ${Math.min(...p).toFixed(2)}）で、`
    return [`${by}あなたの発言による依頼として、あなただけに送っています。`]
  }
  // 束の依頼ごとの、届いた時点の送り手を合わせる。依頼者を先にし、一覧に収まらない人は、後ろから「ほか N 人」にまとめる
  const senders = turnSenders(pending.flatMap((i) => i.route.senders))
  if (senders.length === 0) return []
  const ordered = [...senders.filter((s) => s.mentioned), ...senders.filter((s) => !s.mentioned)]
  // だれも並べなければ必ず収まる
  for (let shown = ordered.length; ; shown--) {
    const lines = sendersLines(ordered.slice(0, shown), ordered.length - shown)
    if (lines.join("\n").length <= MAX_SENDERS_TEXT) return lines
  }
}

function sendersLines(shown: TurnSender[], omitted: number): string[] {
  const lines = ["この作業中の発言（どの発言による依頼かは分かりません）"]
  for (const [label, mentioned] of [
    ["依頼者", true],
    ["そのほかの発言", false],
  ] as const) {
    const rooms = Map.groupBy(
      shown.filter((s) => s.mentioned === mentioned),
      (s) => safeName(s.room),
    )
    if (rooms.size === 0) continue
    lines.push(label, ...[...rooms].map(([room, list]) => `・${room}：${list.map((s) => safeName(s.name)).join("、")}`))
  }
  if (omitted !== 0) lines.push(`・ほか ${omitted} 人`)
  return lines
}

/** 送った人やルームの持ち主が決める名前を、文面に入れられる形にする。改行で偽の答え方を紛れ込ませない */
function safeName(s: string): string {
  return truncate(s.replace(/[\p{Cc}\p{Zl}\p{Zp}\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ").trim() || "（名前なし）", MAX_NAME)
}

/** 束を送る前に文面の長さを測るときの ID（本物と同じ 5 文字） */
const ID_PLACEHOLDER = "xxxxx"

/**
 * 承認依頼の束の文面。依頼が 1 つなら、その依頼だけを書き、入力を省いて max に収める。
 * narrowed は、受け取る人が束の送り先の 1 人か
 */
function approvalText(pending: Pick<PendingRequest, "id" | "req" | "route">[], id: string, max: number, narrowed: boolean): string {
  const route = routeLines(pending, narrowed)
  if (pending.length === 1) {
    const { req } = pending[0]!
    const head = [`🔐 実行の承認：${req.requireFullDisplay ? req.title : truncate(req.title, MAX_SINGLE_TITLE)}`, ...(route.length === 0 ? [] : ["", ...route])].join("\n")
    const answers = [`許可：yes ${id}`, ...(req.always ? [`常に許可：always ${id}（${req.always}）`] : []), `拒否：no ${id}`].join("\n")
    const room = Math.min(1500, max - head.length - answers.length - 4)
    return [head, "", req.requireFullDisplay ? req.input : truncate(req.input, room), "", answers].join("\n")
  }
  const items = pending.map((i, n) =>
    [
      `${n + 1}. ${truncate(i.req.title, MAX_BATCH_TITLE)}`,
      truncate(i.req.input, MAX_BATCH_INPUT),
      ...(i.req.always ? [`常に許可の範囲：${i.req.always}`] : []),
      `（この依頼だけ：yes ${i.id}・${i.req.always ? `always ${i.id}・` : ""}no ${i.id}）`,
    ].join("\n"),
  )
  const always = pending.every((i) => i.req.always) ? [`すべて常に許可：always ${id}`] : []
  return [
    `🔐 実行の承認（${pending.length} 件）`,
    "",
    ...(route.length === 0 ? [] : [...route, ""]),
    `すべて許可：yes ${id}`,
    ...always,
    `すべて拒否：no ${id}`,
    "",
    ...items.flatMap((t) => [t, ""]),
  ]
    .join("\n")
    .trimEnd()
}

/** max 文字を超えるなら、省いたことを書き添えて、全体を max 文字に収める */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const note = (n: number) => `…（${n} 文字を省略）`
  let keep = Math.max(0, max - note(s.length).length)
  // 絵文字など（サロゲートペア）の途中で切らない
  const code = s.charCodeAt(keep - 1)
  if (code >= 0xd800 && code <= 0xdbff) keep--
  return s.slice(0, keep) + note(s.length - keep)
}
