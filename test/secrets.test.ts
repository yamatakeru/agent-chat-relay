// scripts/relay.sh secrets。dotenvx が無ければ成功の側は飛ばす（CI では RELAY_TEST_REQUIRE_DOTENVX=1 で失敗させる）
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const repo = resolve(import.meta.dir, "..")
const KEY = "RELAY_CHATWORK_API_TOKEN"
const hasDotenvx = Bun.which("dotenvx") !== null
if (!hasDotenvx && process.env.RELAY_TEST_REQUIRE_DOTENVX === "1") throw new Error("dotenvx が見つかりません")

let dir: string
let envFile: string

beforeEach(() => {
  // /tmp は使わない（AGENTS.md）
  const base = join(repo, ".local")
  mkdirSync(base, { recursive: true })
  dir = mkdtempSync(join(base, "test-secrets-"))
  envFile = join(dir, ".env")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function secrets(input: string, env: Record<string, string | undefined> = {}) {
  const r = Bun.spawnSync([join(repo, "scripts/relay.sh"), "secrets", "chatwork"], {
    env: { ...process.env, RELAY_ENV_FILE: envFile, ...env },
    stdin: Buffer.from(`${input}\n`),
    stderr: "pipe",
  })
  return { code: r.exitCode, stderr: r.stderr.toString() }
}

function decrypt(key: string): string {
  // Bun がリポジトリ直下の .env から読み込んだ DOTENV_PUBLIC_KEY などは外す
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("DOTENV_")))
  const r = Bun.spawnSync(["dotenvx", "get", key, "--overload", "--strict", "-f", envFile, "-fk", join(dir, ".env.keys")], { env })
  expect(r.exitCode).toBe(0)
  return r.stdout.toString().trim()
}

/** 終了コードを返すだけの偽の dotenvx を、PATH の先頭に置く */
function fakeDotenvx(code: number) {
  const bin = join(dir, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "dotenvx"), `#!/bin/sh\nexit ${code}\n`)
  chmodSync(join(bin, "dotenvx"), 0o755)
  return { PATH: `${bin}:${process.env.PATH}` }
}

const keyLines = () => readFileSync(envFile, "utf8").split("\n").filter((l) => l.startsWith(`${KEY}=`))

describe("secrets", () => {
  test.skipIf(!hasDotenvx)("入れ直すと、同じキーは 1 行のまま新しい値になる。一時ファイルは残らず、自分だけが読める", () => {
    expect(secrets("firsttoken").code).toBe(0)
    expect(secrets("secondtoken").code).toBe(0)
    expect(keyLines()).toEqual([expect.stringMatching(new RegExp(`^${KEY}='encrypted:`))])
    expect(decrypt(KEY)).toBe("secondtoken")
    expect(readdirSync(dir).sort()).toEqual([".env", ".env.keys"])
    expect(statSync(envFile).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, ".env.keys")).mode & 0o777).toBe(0o600)
  })

  test.skipIf(!hasDotenvx)("ほかのキーは残し、重複していた同じキーの行はまとめる", () => {
    writeFileSync(envFile, `OTHER='keep'\n${KEY}='old1'\n${KEY}='old2'\n`)
    expect(secrets("newtoken").code).toBe(0)
    expect(readFileSync(envFile, "utf8")).toContain("OTHER='keep'")
    expect(keyLines()).toHaveLength(1)
    expect(decrypt(KEY)).toBe("newtoken")
  })

  test("暗号化に失敗したら、.env は元のまま、一時ファイルも残さない", () => {
    const before = `${KEY}='encrypted:previous'\n`
    writeFileSync(envFile, before)
    const r = secrets("leakedtoken", fakeDotenvx(1))
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("暗号化に失敗した")
    expect(readFileSync(envFile, "utf8")).toBe(before)
    expect(readdirSync(dir).sort()).toEqual([".env", "bin"])
  })

  test("暗号化が成功と答えても、暗号化されていなければ保存しない", () => {
    expect(secrets("leakedtoken", fakeDotenvx(0)).code).not.toBe(0)
    expect(readdirSync(dir)).toEqual(["bin"])
  })
})
