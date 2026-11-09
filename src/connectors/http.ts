// 接続部が API を呼ぶときの共通の部分（タイムアウト、本文の形、エラー、回数制限での一時停止、添付の取得）と、
// Webhook の署名の検証。認証、エラーの本文、回数制限の読み方は、サービスごとに接続部が渡す。

import { createHmac, timingSafeEqual } from "node:crypto"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    /** サービスが返したエラーの文面 */
    readonly apiMessage: string,
    message: string,
  ) {
    super(message)
  }
}

/** オブジェクトは JSON で送る */
type Body = object | URLSearchParams | FormData

export type ApiConfig = {
  /** エラーの文面に入れるサービスの名前 */
  label: string
  base: string
  /** 認証のヘッダー。呼ぶたびに作る（期限のあるトークンを更新するサービスがある） */
  auth: () => Record<string, string> | Promise<Record<string, string>>
  /** エラーの本文から、サービスの文面を取り出す */
  errorMessage: (raw: string) => string
  /** 429 のときの扱い。resumeAt（ミリ秒）を返すと、その時刻まで呼び出しを止める。なければ、ふつうのエラーにする */
  rateLimited?: (res: Response, apiMessage: string, now: number) => { resumeAt?: number; message: string }
  now?: () => number
}

export class ApiClient {
  private readonly base: string
  private readonly origin?: string
  private pausedUntil = 0

  constructor(private readonly cfg: ApiConfig) {
    this.base = cfg.base.replace(/\/$/, "")
    this.origin = URL.parse(this.base)?.origin
  }

  /** 回数制限で、呼び出しを止めているか */
  get paused(): boolean {
    return this.now() < this.pausedUntil
  }

  /** API を呼び、JSON の応答を返す。本文がない（204 など）ときは null */
  async call(method: string, path: string, body?: Body, timeoutMs = 15_000): Promise<unknown> {
    this.checkPaused()
    const headers: Record<string, string> = { ...(await this.cfg.auth()) }
    let payload: string | URLSearchParams | FormData | undefined
    if (body === undefined || body instanceof URLSearchParams || body instanceof FormData) {
      payload = body
    } else {
      payload = JSON.stringify(body)
      headers["Content-Type"] = "application/json"
    }
    const res = await fetch(`${this.base}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) await this.fail(res)
    const raw = await res.text()
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`${this.cfg.label} API: 応答を読めませんでした（${method} ${path.split("?")[0]}）`)
    }
  }

  /**
   * 添付を取得する。url は API の中のパス（/ で始まる）か、保存先の完全な URL。保存先が API の外のホストのこともあるので、
   * https か、API と同じ origin（モック）の URL だけを許す。転送（3xx）は自分でたどる。
   * auth は、認証を付ける範囲。none：付けない（Chatwork の取得用 URL）、first：最初の URL だけ（LINE）、
   * all：転送先にも（LINE WORKS は、転送先の保存先にも認証が要る）
   */
  async download(url: string, auth: "none" | "first" | "all", timeoutMs = 120_000): Promise<Response> {
    this.checkPaused()
    const signal = AbortSignal.timeout(timeoutMs)
    let target = URL.parse(url.startsWith("/") ? `${this.base}${url}` : url)
    // 転送は、ふつう 1 回（API → 保存先）。それより多ければ、おかしいものとして止める
    for (let hop = 0; hop < 3 && target; hop++) {
      if (target.protocol !== "https:" && target.origin !== this.origin) break
      const withAuth = auth === "all" || (auth === "first" && hop === 0)
      const res = await fetch(target, { headers: withAuth ? await this.cfg.auth() : {}, redirect: "manual", signal })
      const location = res.headers.get("location")
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel()
        target = URL.parse(location, target.href)
        continue
      }
      if (!res.ok) await this.fail(res)
      return res
    }
    throw new Error(`${this.cfg.label} から取得できませんでした（取得用の URL が使えません）`)
  }

  private checkPaused(): void {
    if (this.paused) {
      throw new Error(`${this.cfg.label} の API の回数制限に達しています。${Math.ceil((this.pausedUntil - this.now()) / 1000)} 秒後に使えます`)
    }
  }

  private async fail(res: Response): Promise<never> {
    const msg = this.cfg.errorMessage(await res.text())
    if (res.status === 429 && this.cfg.rateLimited) {
      const r = this.cfg.rateLimited(res, msg, this.now())
      if (r.resumeAt) this.pausedUntil = r.resumeAt
      throw new ApiError(429, msg, r.message)
    }
    throw new ApiError(res.status, msg, `${this.cfg.label} API: HTTP ${res.status}: ${msg}`)
  }

  private now(): number {
    return (this.cfg.now ?? Date.now)()
  }
}

/** Webhook の署名（本文の HMAC-SHA256 を Base64 にしたもの）。LINE と LINE WORKS で同じ方式 */
export function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64")
}

export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, body), "base64")
  const given = Buffer.from(signature, "base64")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** JSON のエラーの本文から、文面を取り出す。読めなければ先頭を返す */
export function jsonError(raw: string, pick: (body: Record<string, unknown>) => unknown): string {
  try {
    return String(pick(JSON.parse(raw) as Record<string, unknown>) ?? "")
  } catch {
    return raw.slice(0, 200)
  }
}
