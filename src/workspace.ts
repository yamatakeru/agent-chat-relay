import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
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
 * 中に「すべて無視する」.gitignore を置く。.relay/ は中継のものなので、毎回置き換える。管理者の .gitignore には触れない
 */
export function relayDir(workspace: string): string {
  const dir = join(workspace, ".relay")
  // ディレクトリがリンクだと、.gitignore の作成や、古い添付の削除が、リンク先に及ぶ
  for (const p of [dir, join(dir, "inbox")]) {
    if (isLink(p)) throw new Error(`作業ディレクトリの ${relative(workspace, p)} がシンボリックリンクのため、起動しません: ${p}`)
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  // すでにある .gitignore を通して書くと、リンクやハードリンクの先に及ぶ。消してから作ると、その間は無視されない。
  // 新しいファイルに書いてから名前を付け替え、ディレクトリの項目を 1 回で置き換える
  const tmp = join(dir, `.gitignore.${process.pid}.${crypto.randomUUID()}`)
  try {
    writeFileSync(tmp, "*\n", { flag: "wx" })
    renameSync(tmp, join(dir, ".gitignore"))
  } finally {
    rmSync(tmp, { force: true })
  }
  return dir
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * git のリポジトリの場所を変える環境変数。git init は、作業ディレクトリではなく、これらが指す場所に書く。
 * 確認で止まる前に作業ディレクトリの外へ書かないよう、git init の前に止める
 */
const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_INDEX_FILE"]

/**
 * 作業ディレクトリを独立した git リポジトリにして、上位の設定や AGENTS.md を拾わせない。
 * .git があるかではなく、git から見たリポジトリの最上位が作業ディレクトリ自身であることを確かめる。
 * 直すのは、既存のリポジトリも上書きしない git init だけにする（.git を消して作り直すと、エージェントの履歴を失いうる）。
 * 確かめられなければ起動しない。
 * git の環境変数は取り除かず、ハーネスが受け取るのと同じ環境（env）で確かめる。別の場所を向いていれば、起動しない
 */
export function initWorkspace(workspace: string, git = "git", env: Record<string, string | undefined> = process.env): void {
  const relocating = GIT_LOCATION_ENV.filter((name) => env[name])
  if (relocating.length > 0) {
    throw new Error(`環境変数 ${relocating.join("・")} が git のリポジトリの場所を変えるため、起動しません。外してから起動してください: ${workspace}`)
  }
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  // .git がリンクか、gitdir: を書いたファイルだと、git init がその先のリポジトリに書き、作業ディレクトリの外に及ぶ
  const dotGit = join(workspace, ".git")
  const dotGitStat = lstatSync(dotGit, { throwIfNoEntry: false })
  if (dotGitStat && !dotGitStat.isDirectory()) {
    throw new Error(`作業ディレクトリの .git がディレクトリではない（シンボリックリンクか、別の場所を指すファイル）ため、起動しません。.git を確かめるか、退避してから起動してください: ${dotGit}`)
  }
  // 既存のリポジトリでも安全で、欠けた部分（空の .git など）を補う
  if (!Bun.which(git) || !Bun.spawnSync([git, "init", "-q", workspace], { env }).success) {
    throw new Error(`作業ディレクトリを git リポジトリにできないため、起動しません。git がインストールされているか確かめてください: ${workspace}`)
  }
  const real = realpathSync(workspace)
  const found = Bun.spawnSync([git, "-C", real, "rev-parse", "--show-toplevel", "--absolute-git-dir"], { env })
  if (!found.success || found.stdout.toString() !== `${real}\n${join(real, ".git")}\n`) {
    throw new Error(`作業ディレクトリが、git から見て独立したリポジトリになっていないため、起動しません。.git を確かめるか、退避してから起動してください: ${workspace}`)
  }
}
