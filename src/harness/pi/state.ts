import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

const SESSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/

function contains(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** まだない部分は、その親の実パスに名前を足す。リンク切れはエラーにする。 */
function realLocation(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync(path)
  return join(realLocation(dirname(path)), basename(path))
}

function directory(path: string, allowed: number, recursive = false): void {
  try {
    mkdirSync(path, { mode: 0o700, recursive })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
  }
  const entry = lstatSync(path)
  if (!entry.isDirectory() || entry.uid !== process.getuid?.() || (entry.mode & 0o777 & ~allowed) !== 0 || realpathSync(path) !== path) {
    throw new Error(`pi の管理領域は、自分が所有する実ディレクトリを指定してください: ${path}`)
  }
}

/** 秘密情報・台帳を、リンク経由や他の利用者が読めるファイルから取らない。 */
function privateFile(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const entry = fstatSync(fd)
    if (!entry.isFile() || entry.nlink !== 1 || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0 || entry.size > 1024 * 1024) throw new Error()
    return readFileSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function preparePiState(home: string, cwd: string) {
  const workspace = realpathSync(cwd)
  const root = realLocation(resolve(home))
  const pi = join(root, "pi")
  if (contains(workspace, root) || contains(pi, workspace)) throw new Error("pi の管理領域と作業ディレクトリは分けてください")
  directory(root, 0o755, true)
  directory(pi, 0o700)
  const agentDir = join(pi, "agent")
  const childHome = join(pi, "home")
  const temp = join(pi, "tmp")
  const registry = join(pi, "registered-sessions")
  for (const path of [agentDir, join(agentDir, "sessions"), childHome, temp, registry]) directory(path, 0o700)
  // pi-acp が開いて更新するファイル。既存の対応表を通じて、別のファイルへ書かない。
  const map = lstatSync(join(agentDir, "pi-acp-session-map.json"), { throwIfNoEntry: false })
  if (map && (!map.isFile() || map.nlink !== 1 || map.uid !== process.getuid?.() || (map.mode & 0o022) !== 0)) {
    throw new Error("pi-acp の対応表は、自分が所有する通常ファイルでなければ使えません")
  }

  function sessionFile(id: string) {
    if (!SESSION_ID.test(id)) throw new Error("pi のセッション ID が不正です")
    return join(registry, `${id}.json`)
  }
  function record(id: string) {
    return { harness: "pi", workspace, sessionId: id }
  }
  return {
    workspace, agentDir, childHome, temp,
    checkModelFiles() {
      const settings = join(agentDir, "settings.json")
      const auth = join(agentDir, "auth.json")
      const models = join(agentDir, "models.json")
      for (const path of [settings, auth, ...(lstatSync(models, { throwIfNoEntry: false }) ? [models] : [])]) {
        try {
          const value: unknown = JSON.parse(privateFile(path).toString("utf8"))
          if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0) throw new Error()
        } catch {
          throw new Error(`pi 専用の設定・認証を、自分だけが読める通常の JSON ファイルに用意してください: ${path}`)
        }
      }
    },
    requireSession(id: string) {
      const path = sessionFile(id)
      try {
        const saved = JSON.parse(privateFile(path).toString("utf8")) as ReturnType<typeof record>
        const expected = record(id)
        if (saved.harness === expected.harness && saved.workspace === expected.workspace && saved.sessionId === expected.sessionId) return
      } catch {
        // 台帳を読めない場合も、記録がない場合と同じように起動しない。
      }
      throw new Error("同じ作業ディレクトリで中継が作った pi のセッションに限って再開できます")
    },
    registerSession(id: string) {
      // セッション ID は新規。既存の台帳やリンクには書かない。
      writeFileSync(sessionFile(id), JSON.stringify(record(id)) + "\n", { flag: "wx", mode: 0o600 })
    },
  }
}
