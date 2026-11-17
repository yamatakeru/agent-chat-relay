// CLI としての動き（ADR 0019）：データの置き場、秘密情報のファイル、Bun に cwd のファイルを読ませないこと
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { loadSecrets, parseSecrets, relayHome, secretsFile, storeSecrets } from "../src/home.ts"
import { BUN_ISOLATED, harnessConfig } from "../src/harness/config.ts"

const repo = resolve(import.meta.dir, "..")
let dir: string

beforeEach(() => {
  // /tmp は使わない（AGENTS.md）
  mkdirSync(join(repo, ".local"), { recursive: true })
  dir = mkdtempSync(join(repo, ".local", "test-cli-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const mode = (p: string) => statSync(p).mode & 0o777

describe("データの置き場", () => {
  test("既定はホームの下で、起動したディレクトリによらない。環境変数で変えられる", () => {
    expect(relayHome({})).toBe(join(homedir(), ".agent-chat-relay"))
    expect(relayHome({ RELAY_HOME: "" })).toBe(join(homedir(), ".agent-chat-relay"))
    expect(relayHome({ RELAY_HOME: dir })).toBe(dir)
    expect(secretsFile({}, dir)).toBe(join(dir, ".env"))
    expect(secretsFile({ RELAY_ENV_FILE: join(dir, "x.env") }, dir)).toBe(join(dir, "x.env"))
  })
})

describe("秘密情報のファイル", () => {
  test("KEY=VALUE を読み、コメントと空行を飛ばし、引用符を外す", () => {
    expect(parseSecrets("# c\n\nA=1\nB = \"two\"\nC='3'\nbad\n=x\n")).toEqual({ A: "1", B: "two", C: "3" })
  })

  test("保存すると 0600 になり、ほかの行は残し、同じ項目は置き換える。ディレクトリは 0700 で作る", () => {
    const f = join(dir, "home", ".env")
    storeSecrets(f, { A: "1", B: "2" })
    expect(mode(f)).toBe(0o600)
    expect(mode(join(dir, "home"))).toBe(0o700)
    writeFileSync(f, "# keep\nA=1\nB=2\n")
    storeSecrets(f, { B: "3" })
    expect(readFileSync(f, "utf8")).toBe("# keep\nA=1\nB=3\n")
    expect(mode(f)).toBe(0o600)
  })

  test("空の値と改行を含む値は保存しない", () => {
    const f = join(dir, ".env")
    expect(() => storeSecrets(f, { A: "" })).toThrow("空です")
    expect(() => storeSecrets(f, { A: "x\ny" })).toThrow("改行")
    expect(existsSync(f)).toBe(false)
  })

  test("読み込むと、まだない環境変数にだけ設定する。読み込み済みなら読まない。自分以外も読めたら知らせる", () => {
    const f = join(dir, ".env")
    writeFileSync(f, "A=file\nB=file\n", { mode: 0o600 })
    const warns: string[] = []
    const env: Record<string, string | undefined> = { A: "env" }
    loadSecrets(f, env, (m) => void warns.push(m))
    expect(env).toEqual({ A: "env", B: "file" })
    expect(warns).toEqual([])

    const loaded: Record<string, string | undefined> = { RELAY_ENV_LOADED: "1" }
    loadSecrets(f, loaded, () => {})
    expect(loaded.B).toBeUndefined()

    chmodSync(f, 0o644)
    loadSecrets(f, {}, (m) => void warns.push(m))
    expect(warns[0]).toContain("chmod 600")
  })
})

describe("secrets コマンド", () => {
  const run = (args: string[], input: string) =>
    Bun.spawnSync([...BUN_ISOLATED, join(repo, "src/main.ts"), ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, RELAY_HOME: join(dir, "home") },
      stdin: Buffer.from(input),
      stderr: "pipe",
      stdout: "pipe",
    })

  test("入力を <home>/.env に保存する。複数の項目は順に読む", () => {
    expect(run(["secrets", "line"], "sec\ntok\n").exitCode).toBe(0)
    const f = join(dir, "home", ".env")
    expect(parseSecrets(readFileSync(f, "utf8"))).toEqual({ RELAY_LINE_CHANNEL_SECRET: "sec", RELAY_LINE_CHANNEL_TOKEN: "tok" })
    expect(mode(f)).toBe(0o600)
  })

  test("知らないサービスと空の入力は拒否する", () => {
    expect(run(["secrets", "slack"], "x\n").stderr.toString()).toContain("line・chatwork・discord")
    expect(run(["secrets", "discord"], "\n").exitCode).toBe(1)
    expect(existsSync(join(dir, "home", ".env"))).toBe(false)
  })
})

test("Bun で動かすプログラムには、cwd の .env と bunfig.toml を読ませない", () => {
  writeFileSync(join(dir, ".env"), "FROM_CWD=1\n")
  writeFileSync(join(dir, "pre.ts"), "process.env.PRELOADED = '1'\n")
  writeFileSync(join(dir, "bunfig.toml"), 'preload = ["./pre.ts"]\n')
  const script = join(dir, "..", `probe-${process.pid}.ts`)
  writeFileSync(script, "console.log(JSON.stringify({ env: process.env.FROM_CWD ?? null, pre: process.env.PRELOADED ?? null }))\n")
  try {
    const plain = Bun.spawnSync([process.execPath, script], { cwd: dir, env: { PATH: process.env.PATH } })
    const isolated = Bun.spawnSync([...BUN_ISOLATED, script], { cwd: dir, env: { PATH: process.env.PATH } })
    // 対策しなければ読まれることを、比較のために確かめる
    expect(JSON.parse(plain.stdout.toString())).toEqual({ env: "1", pre: "1" })
    expect(JSON.parse(isolated.stdout.toString())).toEqual({ env: null, pre: null })
  } finally {
    rmSync(script, { force: true })
  }
})

test.skipIf(!Bun.which("claude"))("claude-agent-acp は、このパッケージの依存から探し、cwd のファイルを読ませずに起動する", () => {
  const log = { info: () => {}, error: () => {} }
  const cfg = harnessConfig("claude", dir, { url: "http://127.0.0.1/mcp", token: "t" }, { inheritSettings: false, memory: false }, log, false, {})
  expect(cfg.command.slice(0, 3)).toEqual(BUN_ISOLATED)
  expect(cfg.command[3]).toBe(join(repo, "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"))
})
