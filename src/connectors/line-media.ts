// エージェントが返す画像を、推測できない URL で公開する（ADR 0005）。LINE は画像を受け取らず、開かれるたびに URL から取得する。
// URL を知っていれば誰でも見られる。名前は 256 ビットの乱数にし、一覧は出さない。URL はログに出さない。

import { randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { RETENTION_MS } from "../core/retention.ts"

// LINE の画像メッセージの上限（本体 10MB、プレビュー 1MB）
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_PREVIEW_BYTES = 1024 * 1024
// 小さいファイルが巨大な画像に展開される（圧縮爆弾）のを防ぐ
const MAX_PIXELS = 40_000_000
// 43 は、32 バイトの乱数を base64url にした長さ
const NAME_RE = /^[A-Za-z0-9_-]{43}(_p)?\.(jpg|png)$/
const EXTENSIONS: Record<string, string> = { jpeg: "jpg", png: "png" }
const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png" }

export class MediaStore {
  constructor(readonly dir: string) {}

  /** 画像を保存し、本体とプレビューのファイル名を返す。JPEG と PNG で 10MB までに限る */
  async publish(path: string): Promise<{ original: string; preview: string }> {
    const file = Bun.file(path)
    if (file.size > MAX_IMAGE_BYTES) throw new Error(`画像が大きすぎます（10MB まで）: ${path}`)
    const data = await file.bytes()
    const meta = await new Bun.Image(data, { maxPixels: MAX_PIXELS }).metadata().catch(() => undefined)
    const ext = meta && EXTENSIONS[meta.format]
    if (!ext) throw new Error(`送れるのは JPEG と PNG の画像だけです: ${path}`)

    const name = randomBytes(32).toString("base64url")
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const original = `${name}.${ext}`
    await writeFile(join(this.dir, original), data, { mode: 0o600 })
    if (data.length <= MAX_PREVIEW_BYTES) return { original, preview: original }
    const preview = `${name}_p.jpg`
    await writeFile(join(this.dir, preview), await shrink(data), { mode: 0o600 })
    return { original, preview }
  }

  /** GET /media/<名前>。名前の形に合わないものは 404 にする */
  serve(name: string): Response {
    if (!NAME_RE.test(name)) return new Response("not found", { status: 404 })
    return new Response(Bun.file(join(this.dir, name)), {
      headers: {
        "Content-Type": TYPES[name.split(".").pop()!]!,
        "Cache-Control": `private, max-age=${RETENTION_MS / 1000}`,
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex",
        "Referrer-Policy": "no-referrer",
      },
    })
  }
}

/** 1MB 以下の JPEG の縮小版を作る。大きい辺の長さを大きい順に試し、収まった最初のものを使う */
async function shrink(data: Uint8Array): Promise<Uint8Array> {
  for (const side of [1024, 512, 240]) {
    const out = await new Bun.Image(data, { maxPixels: MAX_PIXELS }).resize(side, side, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).bytes()
    if (out.length <= MAX_PREVIEW_BYTES) return out
  }
  throw new Error("プレビューを作れませんでした")
}
