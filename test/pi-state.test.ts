import assert from "node:assert/strict"
import { test } from "bun:test"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { preparePiState } from "../src/harness/pi/state.ts"

function fixture(run: (home: string, cwd: string, outside: string) => void) {
  const local = join(import.meta.dir, "..", ".local")
  mkdirSync(local, { recursive: true })
  const root = realpathSync(mkdtempSync(join(local, "test-pi-state-")))
  try {
    const cwd = join(root, "workspace")
    mkdirSync(cwd)
    run(join(root, "relay"), cwd, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("pi の専用領域は作業ディレクトリやリンク先に作らない", () => fixture((home, cwd, root) => {
  assert.throws(() => preparePiState(join(cwd, "relay"), cwd), /管理領域と作業ディレクトリ/)
  assert(!existsSync(join(cwd, "relay")))
  mkdirSync(home, { mode: 0o700 })
  symlinkSync(cwd, join(home, "pi"))
  assert.throws(() => preparePiState(home, cwd), /実ディレクトリ/)
  assert(!existsSync(join(cwd, "agent")))
  const alias = join(root, "alias")
  symlinkSync(cwd, alias)
  assert.throws(() => preparePiState(join(alias, "relay"), cwd), /管理領域と作業ディレクトリ/)
}))

test("pi の専用領域と設定・認証の所有権・モードを検査する", () => fixture((home, cwd, root) => {
  const state = preparePiState(home, cwd)
  for (const dir of [state.agentDir, state.childHome, state.temp, join(state.agentDir, "sessions")]) {
    assert.equal(statSync(dir).mode & 0o777, 0o700)
  }
  const config = join(state.agentDir, "settings.json")
  const auth = join(state.agentDir, "auth.json")
  assert.throws(() => state.checkModelFiles(), /settings\.json/)
  writeFileSync(config, '{"defaultProvider":"example","defaultModel":"fake"}', { mode: 0o600 })
  const otherAuth = join(root, "other-auth.json")
  writeFileSync(otherAuth, '{"example":{"type":"api_key","key":"dummy"}}', { mode: 0o600 })
  for (const link of [symlinkSync, linkSync]) {
    link(otherAuth, auth)
    assert.throws(() => state.checkModelFiles(), /auth\.json/)
    rmSync(auth)
  }
  writeFileSync(auth, '{"example":{"type":"api_key","key":"dummy"}}', { mode: 0o644 })
  assert.throws(() => state.checkModelFiles(), /auth\.json/)
  chmodSync(auth, 0o600)
  state.checkModelFiles()
  const map = join(state.agentDir, "pi-acp-session-map.json")
  linkSync(otherAuth, map)
  assert.throws(() => preparePiState(home, cwd), /pi-acp の対応表/)
  rmSync(map)
  chmodSync(state.temp, 0o777)
  assert.throws(() => preparePiState(home, cwd), /実ディレクトリ/)
}))

test("pi の再開台帳には正規の ID と作業ディレクトリの実パスを記録する", () => fixture((home, cwd, root) => {
  const state = preparePiState(home, cwd)
  const valid = crypto.randomUUID()
  assert.throws(() => state.requireSession(valid), /中継が作った/)
  assert.throws(() => state.requireSession("../outside"), /ID が不正/)
  state.registerSession(valid)
  assert.throws(() => state.registerSession(valid), { code: "EEXIST" })
  const alias = join(root, "workspace-alias")
  symlinkSync(cwd, alias)
  preparePiState(home, alias).requireSession(valid)
  const different = join(root, "different")
  mkdirSync(different)
  assert.throws(() => preparePiState(home, different).requireSession(valid), /中継が作った/)
  const file = join(home, "pi", "registered-sessions", `${valid}.json`)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  writeFileSync(file, JSON.stringify({ sessionId: valid, workspace: cwd, harness: "other" }))
  assert.throws(() => state.requireSession(valid), /中継が作った/)
}))
