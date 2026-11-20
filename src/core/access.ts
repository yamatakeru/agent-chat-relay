// ルームの登録・送信者の許可・ペアリング（docs/relay.md）。
// 公式の Claude Code Discord プラグインの access.json を手本にした。
// ID はすべて「サービス名:サービス内の ID」（例：line:C0123…）で持つ。
// 親の中にある場（Discord のスレッド）は「親の ID/子の ID」とし、親の登録を引き継ぐ（ADR 0011）。

import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * 受信モード（ADR 0028）。mention：メンション（Bot の発言への返信を含む）のある発言だけを渡す。
 * exceptOthers：他人宛ての印があり、メンションのない発言を除いて渡す。all：すべて渡す
 */
export const RECEIVE_MODES = { mention: "メンション時", exceptOthers: "他人宛てを除く", all: "すべて" } as const
export type ReceiveMode = keyof typeof RECEIVE_MODES

export function isReceiveMode(v: unknown): v is ReceiveMode {
  return (Object.keys(RECEIVE_MODES) as unknown[]).includes(v)
}

export type RoomPolicy = {
  receive: ReceiveMode
  /** 空なら、ルームの誰の発言でも渡す。空でなければ、この人たちの発言だけを渡す */
  allowFrom: string[]
}

export type Pending = {
  /** room：ルームの登録。user：DM の相手を許可リストに入れる */
  kind: "room" | "user"
  target: string
  createdAt: number
  expiresAt: number
  /** コードを返した回数。2 回で打ち切る */
  replies: number
}

export type Access = {
  /** DM で話せる人。実行承認の依頼も、この人たちの DM へ送る */
  allowFrom: string[]
  rooms: Record<string, RoomPolicy>
  pending: Record<string, Pending>
}

export type Inbound = {
  room: string
  sender: string
  isDM: boolean
  mentioned: boolean
  /**
   * 送信者以外の人への宛て（メンション、その人の発言への返信・引用）がある。全員宛ては含まない。
   * Bot への宛ても含んでよい。Bot への宛てはメンションになり、メンションを優先するので、他人宛ての印として働くのは Bot 以外への宛てだけ
   */
  toOthers?: boolean
}

export type GateResult =
  | { action: "deliver" }
  /** 登録したルームの、渡さない発言。履歴には残す。toOthers は、他人宛てとして外したとき */
  | { action: "record"; toOthers?: true }
  | { action: "drop" }
  | { action: "pair"; code: string; isResend: boolean }

const PAIRING_TTL_MS = 60 * 60 * 1000
const MAX_PENDING = 3

function emptyAccess(): Access {
  return { allowFrom: [], rooms: {}, pending: {} }
}

export class AccessStore {
  /** 知らない受信モードを書いたルームと、その値。同じものは続けてログに書かない */
  private readonly warned = new Map<string, unknown>()

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 受信のたびに読み直すので、登録や許可の変更に再起動は不要 */
  load(): Access {
    let raw: string
    try {
      raw = readFileSync(this.path, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyAccess()
      throw err
    }
    try {
      const a = JSON.parse(raw) as Partial<Access>
      return { allowFrom: a.allowFrom ?? [], rooms: this.normalizeRooms(a.rooms ?? {}), pending: a.pending ?? {} }
    } catch {
      // 壊れたファイルは退避して、空の状態から始める。誰の発言も渡さない状態で動く（フェイルクローズ）
      renameSync(this.path, `${this.path}.corrupt-${this.now()}`)
      console.error(`relay: ${this.path} が壊れていたため脇へ移しました`)
      return emptyAccess()
    }
  }

  save(a: Access): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.path)
  }

  /** 発言をエージェントに渡すかを決める。ペアリングのコードを出すときは保存も行う */
  gate(m: Inbound): GateResult {
    const a = this.load()
    let changed = this.pruneExpired(a)
    let result: GateResult
    if (m.isDM) {
      result = a.allowFrom.includes(m.sender) ? { action: "deliver" } : this.pair(a, "user", m.sender)
    } else {
      const key = registrationOf(m.room)
      const policy = a.rooms[key]
      if (!policy) {
        // 未登録のルームでは、Bot に話しかけられたときだけコードを返す。スレッドなら、親を登録するコードになる
        result = m.mentioned ? this.pair(a, "room", key) : { action: "drop" }
      } else if ((policy.allowFrom.length > 0 && !policy.allowFrom.includes(m.sender)) || (policy.receive === "mention" && !m.mentioned)) {
        result = { action: "record" }
      } else if (policy.receive === "exceptOthers" && !m.mentioned && m.toOthers) {
        result = { action: "record", toOthers: true }
      } else {
        result = { action: "deliver" }
      }
    }
    if (result.action === "pair") changed = true
    if (changed) this.save(a)
    return result
  }

  /** Bot がルームに追加されたとき。未登録ならコードを出す */
  joined(room: string): GateResult {
    const a = this.load()
    this.pruneExpired(a)
    const key = registrationOf(room)
    if (a.rooms[key]) return { action: "drop" }
    const r = this.pair(a, "room", key)
    this.save(a)
    return r
  }

  /** 管理者が端末で打ったコードを確認し、登録する。登録したものを返す */
  approve(code: string): Pending {
    const a = this.load()
    this.pruneExpired(a)
    const key = code.trim().toLowerCase()
    const p = a.pending[key]
    if (!p) throw new Error("コードが見つからないか、期限（1 時間）が切れています")
    if (p.kind === "user") {
      if (!a.allowFrom.includes(p.target)) a.allowFrom.push(p.target)
    } else {
      a.rooms[p.target] ??= { receive: "mention", allowFrom: [] }
    }
    delete a.pending[key]
    this.save(a)
    return p
  }

  /** 登録したルームの受信モードを変える */
  setReceive(room: string, mode: ReceiveMode): void {
    const a = this.load()
    const policy = a.rooms[room]
    if (!policy) throw new Error("登録していないルームです。access の一覧の番号で指定できます")
    policy.receive = mode
    this.save(a)
  }

  /**
   * 受信モードを読む。古い形（requireMention）は読み替える。知らない値は「メンション時」として扱い、ログに書く。
   * 保存するときは receive だけを書く
   */
  private normalizeRooms(rooms: Record<string, Partial<RoomPolicy> & { requireMention?: boolean }>): Record<string, RoomPolicy> {
    const out: Record<string, RoomPolicy> = {}
    for (const [room, { receive, requireMention, allowFrom }] of Object.entries(rooms)) {
      let mode: ReceiveMode
      if (isReceiveMode(receive)) mode = receive
      else if (receive === undefined) mode = requireMention === false ? "all" : "mention"
      else {
        mode = "mention"
        if (this.warned.get(room) !== receive) console.error(`relay: access.json の受信モード ${JSON.stringify(receive)} は使えません。メンション時として扱います`)
        this.warned.set(room, receive)
      }
      out[room] = { receive: mode, allowFrom: allowFrom ?? [] }
    }
    return out
  }

  private pair(a: Access, kind: Pending["kind"], target: string): GateResult {
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.kind !== kind || p.target !== target) continue
      if (p.replies >= 2) return { action: "drop" }
      p.replies++
      return { action: "pair", code, isResend: true }
    }
    if (Object.keys(a.pending).length >= MAX_PENDING) return { action: "drop" }
    const code = randomBytes(3).toString("hex")
    const now = this.now()
    a.pending[code] = { kind, target, createdAt: now, expiresAt: now + PAIRING_TTL_MS, replies: 1 }
    return { action: "pair", code, isResend: false }
  }

  private pruneExpired(a: Access): boolean {
    let changed = false
    for (const [code, p] of Object.entries(a.pending)) {
      if (p.expiresAt < this.now()) {
        delete a.pending[code]
        changed = true
      }
    }
    return changed
  }
}

/**
 * 送信先の制限：登録したルーム（と、ID が「その ID/子」のもの）と、許可した人の DM にだけ送れる。1 対 1 のトークでは、相手の ID がルームになる。
 * 中核は ID の文字列しか見ない。子が本当にその親の中にあるかは、入れ子の ID を使うコネクターが送るときに確認する（Connector.nestedRooms）
 */
export function canSendTo(a: Access, room: string): boolean {
  return registrationOf(room) in a.rooms || a.allowFrom.includes(room)
}

/** 登録を参照するルームの ID。「親/子」（どちらも空でなく、/ は 1 つだけ）の形なら親。ほかの形はそのまま（登録と一致しない） */
export function registrationOf(room: string): string {
  return /^([^/]+)\/[^/.]+$/.exec(room)?.[1] ?? room
}

export function serviceOf(id: string): string {
  return id.slice(0, id.indexOf(":"))
}

export function localId(id: string): string {
  return id.slice(id.indexOf(":") + 1)
}
