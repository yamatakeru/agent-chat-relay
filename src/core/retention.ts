// 受け取った添付と、返した画像を消す時期（ADR 0005）。

import { readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"

/** 受け取った添付と公開した画像を残す期間 */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** dir の直下で、更新から maxAgeMs を過ぎたファイルを消す。消した数を返す */
export function pruneOld(dir: string, maxAgeMs: number): number {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  let n = 0
  for (const name of names) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isFile() && Date.now() - st.mtimeMs > maxAgeMs) {
        rmSync(p)
        n++
      }
    } catch {
      // 途中で消えたものは無視する
    }
  }
  return n
}
