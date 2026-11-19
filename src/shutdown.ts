// 中継の止まり方。ハーネスが終了したら中継も止める。異常終了なら、作業中だったターンのルームへの知らせを送り終わるまで待つ（ADR 0024）。
// main.ts は子プロセスでしか動かずテストが届かないので、ここに切り出して単体テストで守る。process.exit とシグナルの登録は main.ts に残す

import { readFileSync } from "node:fs"
import type { Log } from "./core/relay.ts"

/** ハーネスが異常終了したとき、ルームへの知らせを送り終わるまで待つ上限 */
export const DRAIN_MS = 10_000

/** 管理者による停止（Ctrl+C・SIGTERM）。何度届いても、onStop は 1 回だけ呼ぶ */
export type Stopper = { readonly stopping: boolean; readonly stopped: Promise<void>; stop: () => void }

export function stopper(onStop: () => void): Stopper {
  let stopping = false
  let resolve!: () => void
  const stopped = new Promise<void>((r) => (resolve = r))
  return {
    get stopping() {
      return stopping
    },
    stopped,
    stop: () => {
      if (stopping) return
      stopping = true
      resolve()
      onStop()
    },
  }
}

/**
 * ハーネスの終了を待ってログに書き、中継の終了コードを返す。
 * 管理者が止めたのでなければ、作業中だったターンのルームへの知らせを、送り終わるまで（最大 drainMs）待つ。待っている間に止められたら、待つのをやめる
 */
export async function untilHarnessExits(
  h: { exited: Promise<number>; name: string; logPath: string },
  relay: { drain(timeoutMs: number): Promise<void> },
  stop: Stopper,
  log: Log,
  drainMs = DRAIN_MS,
): Promise<number> {
  const code = await h.exited
  if (code === 0 || stop.stopping) {
    log.info("ハーネスが終了したため、中継も止めます", { harness: h.name, code })
  } else {
    const tail = readFileSync(h.logPath, "utf8").trimEnd().split("\n").slice(-20).join("\n")
    log.error(`ハーネスが異常終了したため、中継も止めます。ハーネスのログ：${h.logPath}（最後の 20 行を下に出す）`, { harness: h.name, code })
    console.error(tail)
  }
  if (!stop.stopping) await Promise.race([relay.drain(drainMs), stop.stopped])
  return code === 0 ? 0 : 1
}
