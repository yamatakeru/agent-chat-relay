import { existsSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

/** 作業ディレクトリ。specified は、管理者が RELAY_WORKSPACE で指定したものか（ADR 0017） */
export type Workspace = { path: string; specified: boolean }

/**
 * 作業ディレクトリを決める。RELAY_WORKSPACE があればそのディレクトリを、なければ <home>/workspace を使う。
 * protect は、作業ディレクトリに含めてはいけない場所（中継のデータと秘密情報の置き場）。
 * 作業ディレクトリの中は、実行承認なしで読めて、ルームへ返せるため
 */
export function resolveWorkspace(env: Record<string, string | undefined>, home: string, protect: string[]): Workspace {
  const given = env.RELAY_WORKSPACE
  if (!given) {
    const path = join(home, "workspace")
    initWorkspace(path)
    return { path, specified: false }
  }
  // 書き間違いで、意図しない空のディレクトリで動き出さないよう、作らない
  const abs = resolve(given)
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`RELAY_WORKSPACE のディレクトリがありません: ${abs}`)
  const path = realpathSync(abs)
  for (const p of protect) {
    if (contains(path, realOrResolved(p))) throw new Error(`RELAY_WORKSPACE が、中継のデータか秘密情報の置き場を含むため、起動しません: ${p}`)
  }
  // 管理者のディレクトリなので、git init しない（上位のディレクトリの設定からの切り離しは保証しない）
  return { path, specified: true }
}

/** dir が target と同じか、target を中に含むか */
function contains(dir: string, target: string): boolean {
  const rel = relative(dir, target)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** 実パスにする。まだないパス（初回の RELAY_HOME など）は、あるところまでを実パスにする */
function realOrResolved(p: string): string {
  const abs = resolve(p)
  if (existsSync(abs)) return realpathSync(abs)
  const parent = dirname(abs)
  return parent === abs ? abs : join(realOrResolved(parent), basename(abs))
}

/**
 * 作業ディレクトリの中の、中継の置き場（.relay/。受け取った添付など）を用意して、その場所を返す。
 * 管理者の git リポジトリを作業ディレクトリにしても、ルームから届いたファイルがコミットされないよう、
 * 中に「すべて無視する」.gitignore を置く。.relay/ は中継のものなので、中身が違えば書き直す。管理者の .gitignore には触れない
 */
export function relayDir(workspace: string): string {
  const dir = join(workspace, ".relay")
  // リンクだと、.gitignore の書き込みや、古い添付の削除が、リンク先に及ぶ
  for (const p of [dir, join(dir, ".gitignore"), join(dir, "inbox")]) {
    if (isLink(p)) throw new Error(`作業ディレクトリの ${relative(workspace, p)} がシンボリックリンクのため、起動しません: ${p}`)
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, ".gitignore"), "*\n")
  return dir
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** 作業ディレクトリを独立した git リポジトリにして、上位の設定や AGENTS.md を拾わせない。できなければ起動しない */
export function initWorkspace(workspace: string, git = "git"): void {
  if (existsSync(join(workspace, ".git"))) return
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  if (!Bun.which(git) || !Bun.spawnSync([git, "init", "-q", workspace]).success) {
    throw new Error("作業ディレクトリを git リポジトリにできないため、起動しません")
  }
}
