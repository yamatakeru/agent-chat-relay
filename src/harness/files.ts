// 中継が作業場所と .local/relay に書くファイルの後始末。

import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs"
import { dirname, join } from "node:path"

/** 受け取った添付と公開した画像を残す期間（ADR 0005） */
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

/** 追記用のファイル。max バイトを超えそうになったら <path>.1 に移し（前の .1 は消える）、新しく始める */
export class RotatingFile {
  private fd: number
  private size: number

  constructor(
    private readonly path: string,
    private readonly max: number,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.fd = openSync(path, "a", 0o600)
    this.size = fstatSync(this.fd).size
  }

  write(chunk: Uint8Array): void {
    if (this.size > 0 && this.size + chunk.length > this.max) {
      closeSync(this.fd)
      renameSync(this.path, `${this.path}.1`)
      this.fd = openSync(this.path, "a", 0o600)
      this.size = 0
    }
    writeSync(this.fd, chunk)
    this.size += chunk.length
  }

  close(): void {
    closeSync(this.fd)
  }
}
