// 受け取った添付と、返した画像を消す時期（ADR 0005）。

import { readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Log } from "./relay.ts"

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

/** dir の中の、保存から 7 日を過ぎたファイルを、今と 1 時間ごとに消す。止める関数を返す */
export function schedulePrune(dir: string, what: string, log: Log): () => void {
  const prune = () => {
    const removed = pruneOld(dir, RETENTION_MS)
    if (removed > 0) log.info(`7 日を過ぎた${what}を消しました`, { removed })
  }
  prune()
  const timer = setInterval(prune, 60 * 60 * 1000)
  timer.unref()
  return () => clearInterval(timer)
}
