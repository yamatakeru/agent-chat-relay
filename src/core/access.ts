// ルームの登録・送信者の許可・ペアリング（docs/relay.md）。
// 公式の Claude Code Discord プラグインの access.json を手本にした。
// ID はすべて「サービス名:サービス内の ID」（例：line:C0123…）で持つ。

import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type RoomPolicy = {
  /** true：メンション（Bot の発言への返信を含む）のある発言だけを渡す。false：すべて渡す */
  requireMention: boolean
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
}

export type GateResult =
  | { action: "deliver" }
  /** 登録したルームの、渡さない発言。履歴には残す */
  | { action: "record" }
  | { action: "drop" }
  | { action: "pair"; code: string; isResend: boolean }

const PAIRING_TTL_MS = 60 * 60 * 1000
const MAX_PENDING = 3

function emptyAccess(): Access {
  return { allowFrom: [], rooms: {}, pending: {} }
}

export class AccessStore {
  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** 受信のたびに読み直すので、登録や許可の変更に再起動は要らない */
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
      return { allowFrom: a.allowFrom ?? [], rooms: a.rooms ?? {}, pending: a.pending ?? {} }
    } catch {
      // 壊れたファイルは脇へ移して、空から始める。誰の発言も渡さない側に倒れる
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
      const policy = a.rooms[m.room]
      if (!policy) {
        // 未登録のルームでは、Bot に話しかけられたときだけコードを返す
        result = m.mentioned ? this.pair(a, "room", m.room) : { action: "drop" }
      } else if ((policy.allowFrom.length > 0 && !policy.allowFrom.includes(m.sender)) || (policy.requireMention && !m.mentioned)) {
        result = { action: "record" }
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
    if (a.rooms[room]) return { action: "drop" }
    const r = this.pair(a, "room", room)
    this.save(a)
    return r
  }

  /** 管理者が端末で打ったコードを確かめ、登録する。登録したものを返す */
  approve(code: string): Pending {
    const a = this.load()
    this.pruneExpired(a)
    const key = code.trim().toLowerCase()
    const p = a.pending[key]
    if (!p) throw new Error("コードが見つからないか、期限（1 時間）が切れています")
    if (p.kind === "user") {
      if (!a.allowFrom.includes(p.target)) a.allowFrom.push(p.target)
    } else {
      a.rooms[p.target] ??= { requireMention: true, allowFrom: [] }
    }
    delete a.pending[key]
    this.save(a)
    return p
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

/** 送信先の制限：登録したルームと、許可した人の DM にだけ送れる。1 対 1 のトークでは、相手の ID がルームになる */
export function canSendTo(a: Access, room: string): boolean {
  return room in a.rooms || a.allowFrom.includes(room)
}

export function serviceOf(id: string): string {
  return id.slice(0, id.indexOf(":"))
}

export function localId(id: string): string {
  return id.slice(id.indexOf(":") + 1)
}
