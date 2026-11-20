import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { isUtf8 } from "node:buffer"
import { join } from "node:path"
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent"
import { approvePiToolCall } from "../../harness/pi/tool-approval.ts"

const MAX_BYTES = 1024 * 1024
// Darwin の <sys/fcntl.h>。最後だけではなく、途中のシンボリックリンクもたどらない。
const O_NOFOLLOW_ANY = 0x20000000
const flags = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY | O_NOFOLLOW_ANY

function supportsNoFollow(stateDir: string): boolean {
  if (process.platform !== "darwin") return false
  let probe: string | undefined
  try {
    const dir = mkdtempSync(join(stateDir, ".read-probe-"))
    probe = dir
    const file = join(dir, "plain")
    writeFileSync(file, "")
    closeSync(openSync(file, flags))
    symlinkSync("plain", join(dir, "file-link"))
    symlinkSync(".", join(dir, "dir-link"))
    return ["file-link", "dir-link/plain"].every(path => {
      try {
        closeSync(openSync(join(dir, path), flags))
        return false
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "ELOOP"
      }
    })
  } catch {
    return false
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true })
  }
}

function relativeReadPath(workspace: string, path: string): string | undefined {
  const prefix = `${workspace}/`
  const relative = path.startsWith(prefix) ? path.slice(prefix.length) : path.replace(/^\.\//, "")
  // OS に渡すパスだけを判定する。Pi の ~ / @ やファイル名の補完には頼らない。
  if (relative.startsWith("~") || relative.startsWith("@") || relative.includes("\0")) return
  if (relative.split("/").some(part => part === "" || part === "." || part === "..")) return
  return relative
}

function snapshot(workspace: string, path: string): Buffer | undefined {
  const relative = relativeReadPath(workspace, path)
  if (relative === undefined) return
  try {
    if (process.cwd() !== workspace) return
    // 作業ディレクトリを起点にリンクをたどらず開く。確認後にパスを開き直さない。
    const fd = openSync(relative, flags)
    try {
      const stat = fstatSync(fd, { bigint: true })
      if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== statSync(".", { bigint: true }).dev || stat.size < 0n || stat.size > BigInt(MAX_BYTES)) return
      const bytes = Buffer.alloc(Number(stat.size) + 1)
      for (let used = 0; used < bytes.length;) {
        const count = readSync(fd, bytes, used, bytes.length - used, used)
        if (count === 0) {
          const data = bytes.subarray(0, used)
          // 画像などは、承認を得てから Pi 標準の読み取りに任せる。
          return data.includes(0) || !isUtf8(data) ? undefined : data
        }
        used += count
      }
      // 読み取り中に伸びた。この試行の結果は返さない。
    } finally {
      closeSync(fd)
    }
  } catch {
    return
  }
}

export function managedRead(workspace: string, stateDir: string, sessionSignal: AbortSignal) {
  const noFollow = supportsNoFollow(stateDir)
  const stock = createReadToolDefinition(workspace)
  const tool: typeof stock = {
    ...stock,
    async execute(id, params, toolSignal, onUpdate, ctx) {
      const signal = toolSignal ? AbortSignal.any([toolSignal, sessionSignal]) : sessionSignal
      signal.throwIfAborted()
      const bytes = noFollow && ctx.cwd === workspace ? snapshot(workspace, params.path) : undefined
      if (bytes !== undefined) {
        // Pi の行範囲・切り詰めを使うが、どのパスを渡されても実際に確認したバイトだけを返す。
        const read = createReadToolDefinition(workspace, {
          operations: { access: async () => {}, readFile: async () => bytes },
        })
        return read.execute(id, params, signal, onUpdate, ctx)
      }
      const blocked = await approvePiToolCall({ toolName: "read", input: params }, ctx, { sessionSignal: signal })
      if (blocked) throw new Error(blocked.reason)
      signal.throwIfAborted()
      return stock.execute(id, params, signal, onUpdate, ctx)
    },
  }
  return tool
}
