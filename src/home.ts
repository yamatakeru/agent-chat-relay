// 中継のデータの置き場（RELAY_HOME）と、秘密情報のファイル（ADR 0019）。
// どちらも、起動したディレクトリには左右されない。起動したディレクトリや作業ディレクトリは、エージェントが書ける場所でありうるため

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

type Env = Record<string, string | undefined>

/** 中継のデータの置き場。既定は ~/.agent-chat-relay */
export function relayHome(env: Env): string {
  return resolve(env.RELAY_HOME || join(homedir(), ".agent-chat-relay"))
}

/** 秘密情報のファイル。既定は <home>/.env */
export function secretsFile(env: Env, home: string): string {
  return resolve(env.RELAY_ENV_FILE || join(home, ".env"))
}

/** 秘密情報のファイルの KEY=VALUE を読む。空行と # で始まる行は飛ばし、値の両端の引用符は外す */
export function parseSecrets(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    out[line.slice(0, eq).trim()] = value
  }
  return out
}

/**
 * 秘密情報のファイルを読み、まだない環境変数にだけ設定する（環境変数が優先）。
 * scripts/relay.sh が dotenvx で読み込み済み（RELAY_ENV_LOADED）なら読まない。開発用の .env は暗号化されているため
 */
export function loadSecrets(path: string, env: Env, warn: (msg: string) => void): void {
  if (env.RELAY_ENV_LOADED || !existsSync(path)) return
  if ((statSync(path).mode & 0o077) !== 0) warn(`${path} を、自分以外も読めます。chmod 600 ${path} で絞ってください`)
  for (const [k, v] of Object.entries(parseSecrets(readFileSync(path, "utf8")))) env[k] ??= v
}

/**
 * 秘密情報のファイルにあるキーの名前。ハーネスには、これらを渡さない（環境変数で渡したものも含む）。
 * dotenvx で暗号化したファイルでも、キーの名前は平文なので読める
 */
export function secretKeys(path: string): string[] {
  return existsSync(path) ? Object.keys(parseSecrets(readFileSync(path, "utf8"))) : []
}

/** 秘密情報を保存する。ほかの行は残す。ファイルは 0600、新しく作るディレクトリは 0700 にする */
export function storeSecrets(path: string, values: Record<string, string>): void {
  for (const [k, v] of Object.entries(values)) {
    if (!v) throw new Error(`${k} が空です`)
    if (/[\r\n]/.test(v)) throw new Error(`${k} に改行が含まれています`)
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // 同じ項目の行と空行を除いて残し、新しい値を末尾に足す
  const rest = (existsSync(path) ? readFileSync(path, "utf8").split("\n") : []).filter((l) => l && !Object.keys(values).some((k) => l.trim().startsWith(`${k}=`)))
  const tmp = `${path}.${process.pid}.tmp`
  const body = [...rest, ...Object.entries(values).map(([k, v]) => `${k}=${v}`)].join("\n")
  writeFileSync(tmp, `${body}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}
