// ハーネスの stderr を書くファイル。

import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs"
import { dirname } from "node:path"

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
