// 接続部が共通で使う小物。

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const CACHE_CAP = 1000
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024
const TOO_LARGE = "大きすぎるため取得しません（25MB まで）"
export const TRUNCATED_NOTE = "\n\n（長すぎるため、ここから先は省略しました）"

/** 入れて、上限を超えたら最初に入れたものから捨てる。プロセスのメモリにだけ置く覚え書き（重複の除去、ID の対応など）に使う */
export function remember(c: Set<string>, key: string): void
export function remember<V>(c: Map<string, V>, key: string, value: V): void
export function remember<V>(c: Set<string> | Map<string, V>, key: string, value?: V): void {
  if (c instanceof Set) c.add(key)
  else c.set(key, value!)
  if (c.size > CACHE_CAP) c.delete(c.keys().next().value!)
}

/** UTF-16 で limit 単位に収まる長さ。サロゲートペアの途中では切らない */
export function fitUnits(s: string, limit: number): number {
  if (s.length <= limit) return s.length
  const code = s.charCodeAt(limit - 1)
  return code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit
}

/** max 単位を超える本文を切り、省略したことを書き添える */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, fitUnits(text, max - TRUNCATED_NOTE.length)) + TRUNCATED_NOTE
}

/**
 * 本文を、1 通 max 単位で parts 通までに分ける。段落、行、空白の切れ目で分ける（前半にしかなければ、そのまま切る）。
 * 入りきらない分は、最後の 1 通を切って省略を書き添える
 */
export function splitText(text: string, max: number, parts: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > max && out.length < parts - 1) {
    let cut = fitUnits(rest, max)
    for (const sep of ["\n\n", "\n", " "]) {
      const i = rest.lastIndexOf(sep, cut - sep.length)
      if (i > max / 2) {
        cut = i
        break
      }
    }
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(truncate(rest, max))
  return out
}

/** 取得した添付を dir に保存する（25MB まで）。名前は <stem><ext>。ext は記号を除いてから使う */
export async function saveDownload(res: Response, dir: string, stem: string, ext: string): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES) throw new Error(TOO_LARGE)
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_DOWNLOAD_BYTES) throw new Error(TOO_LARGE)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${stem}${ext.replace(/[^.a-zA-Z0-9]/g, "")}`)
  await writeFile(path, buf, { mode: 0o600 })
  return path
}

/** 接続部の API が受け付けるメッセージ ID か（数字だけ）。パスに入れる前に確かめる */
export function assertNumericId(id: string): void {
  if (!/^\d+$/.test(id)) throw new Error("message_id の形が違います")
}
