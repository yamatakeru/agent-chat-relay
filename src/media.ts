// エージェントが返す画像を、推測できない URL で公開する（ADR 0005）。LINE は画像を受け取らず、開かれるたびに URL から取得する。
// URL を知っていれば誰でも見られる。名前は 256 ビットの乱数にし、一覧は出さない。URL はログに出さない。

import { randomBytes } from "node:crypto"
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_PREVIEW_BYTES = 1024 * 1024
const MAX_PIXELS = 40_000_000
const NAME_RE = /^[A-Za-z0-9_-]{43}(_p)?\.(jpg|png)$/
const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png" }

export class MediaStore {
  constructor(readonly dir: string) {}

  /** 画像を保存し、本体とプレビューのファイル名を返す。JPEG と PNG で 10MB までに限る */
  async publish(path: string): Promise<{ original: string; preview: string }> {
    const data = await Bun.file(path).bytes()
    if (data.length > MAX_IMAGE_BYTES) throw new Error(`画像が大きすぎます（10MB まで）: ${path}`)
    const meta = await new Bun.Image(data, { maxPixels: MAX_PIXELS }).metadata().catch(() => undefined)
    const ext = meta?.format === "jpeg" ? "jpg" : meta?.format === "png" ? "png" : undefined
    if (!ext) throw new Error(`送れるのは JPEG と PNG の画像だけです: ${path}`)

    const name = randomBytes(32).toString("base64url")
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const original = `${name}.${ext}`
    writeFileSync(join(this.dir, original), data, { mode: 0o600 })
    if (data.length <= MAX_PREVIEW_BYTES) return { original, preview: original }
    const preview = `${name}_p.jpg`
    writeFileSync(join(this.dir, preview), await shrink(data), { mode: 0o600 })
    return { original, preview }
  }

  /** GET /media/<名前>。名前の形に合わないものは 404 にする */
  serve(name: string): Response {
    if (!NAME_RE.test(name)) return notFound()
    const file = Bun.file(join(this.dir, name))
    return new Response(file, {
      headers: {
        "Content-Type": TYPES[name.split(".").pop()!]!,
        "Cache-Control": "private, max-age=604800",
        "X-Content-Type-Options": "nosniff",
        "X-Robots-Tag": "noindex",
        "Referrer-Policy": "no-referrer",
      },
    })
  }
}

/** 1MB 以下の JPEG の縮小版を作る（LINE のプレビューの上限） */
async function shrink(data: Uint8Array): Promise<Uint8Array> {
  for (const side of [1024, 512, 240]) {
    const out = await new Bun.Image(data, { maxPixels: MAX_PIXELS }).resize(side, side, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 80 }).bytes()
    if (out.length <= MAX_PREVIEW_BYTES) return out
  }
  throw new Error("プレビューを作れませんでした")
}

function notFound(): Response {
  return new Response("not found", { status: 404 })
}

/** dir の直下で、更新から maxAgeMs を過ぎたファイルを消す。消した数を返す */
export function pruneOld(dir: string, maxAgeMs: number, now = Date.now()): number {
  let n = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const name of names) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isFile() && now - st.mtimeMs > maxAgeMs) {
        rmSync(p)
        n++
      }
    } catch {
      // 途中で消えたものは無視する
    }
  }
  return n
}
