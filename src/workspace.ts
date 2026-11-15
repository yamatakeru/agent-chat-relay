import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"

/** 作業ディレクトリを独立した git リポジトリにして、上位の設定や AGENTS.md を拾わせない。できなければ起動しない */
export function initWorkspace(workspace: string, git = "git"): void {
  if (existsSync(join(workspace, ".git"))) return
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  if (!Bun.which(git) || !Bun.spawnSync([git, "init", "-q", workspace]).success) {
    throw new Error("作業ディレクトリを git リポジトリにできないため、起動しません")
  }
}
