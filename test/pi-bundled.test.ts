import assert from "node:assert/strict"
import { test } from "bun:test"
import { randomBytes } from "node:crypto"
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { delimiter, dirname, join, resolve } from "node:path"
import type { Log, PermissionRequest, Verdict } from "../src/core/relay.ts"
import { tempDir } from "./tmp.ts"

const repo = join(import.meta.dir, "..")
// npm pack した配布物でも、同じテストをそのまま実行する。
const src = join(resolve(process.env.RELAY_TEST_PI_PACKAGE ?? repo), "src")
const { AccessStore } = await import(join(src, "core/access.ts")) as typeof import("../src/core/access.ts")
const { mcpHandler } = await import(join(src, "core/mcp.ts")) as typeof import("../src/core/mcp.ts")
const { Relay } = await import(join(src, "core/relay.ts")) as typeof import("../src/core/relay.ts")
const { preparePiLaunch } = await import(join(src, "harness/pi/config.ts")) as typeof import("../src/harness/pi/config.ts")
const { preparePiState } = await import(join(src, "harness/pi/state.ts")) as typeof import("../src/harness/pi/state.ts")
const { BUN_ISOLATED } = await import(join(src, "harness/config.ts")) as typeof import("../src/harness/config.ts")

test("同梱 pi が新規・再開で reply し、組み込みツールに ACP の実行承認を求める", async () => {
  const dir = realpathSync(tempDir("test-pi-"))
  const cwd = join(dir, "project", "workspace")
  const otherCwd = join(dir, "other")
  const home = join(dir, "home")
  const relayHome = join(dir, "relay")
  mkdirSync(cwd, { recursive: true })
  const { agentDir: agent } = preparePiState(relayHome, cwd)
  const sessions = join(agent, "sessions")
  const stderrPath = join(dir, "harness.log")
  const room = "fake:room"
  const auth = "fake-model-key"
  const foreign = "FOREIGN_PI_FIXTURE"
  const foreignSessionDir = join(home, ".pi", "agent", "sessions")
  const foreignSession = join(foreignSessionDir, "terminal.jsonl")
  const foreignId = crypto.randomUUID()
  const unrecorded = crypto.randomUUID()
  for (const path of [cwd, otherCwd, home, sessions, foreignSessionDir]) mkdirSync(path, { recursive: true })
  const decoys = new Map<string, string>()
  function decoy(path: string, text: string) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
    decoys.set(path, text)
  }
  for (const folder of [cwd, dirname(cwd), join(home, ".pi", "agent")]) {
    decoy(join(folder, "AGENTS.md"), foreign)
  }
  decoy(join(cwd, "nested", "AGENTS.md"), foreign)
  const preload = join(dir, "preload.marker")
  const readPath = join("nested", "read.txt")
  decoy(join(cwd, readPath), "first line\nread-fixture\nlast line\n")
  const outside = join(dirname(cwd), "outside.txt")
  decoy(outside, "outside-fixture")
  symlinkSync(outside, join(cwd, "file-link"))
  symlinkSync(dirname(cwd), join(cwd, "dir-link"))
  linkSync(outside, join(cwd, "hard-link"))
  decoy(join(cwd, "large.txt"), "x".repeat(1024 * 1024 + 1))
  decoy(join(cwd, "binary"), "a\0b")
  assert.equal(Bun.spawnSync(["mkfifo", join(cwd, "read-fifo")]).exitCode, 0)
  const command = `test -z "$RELAY_PI_FIXTURE_SECRET$PI_SESSION_DIR$BASH_ENV" && test "$HOME" = ${JSON.stringify(join(relayHome, "pi", "home"))} && printf shell-fixture > shell.txt`
  const operations = {
    read: { args: { path: outside }, target: outside, result: "outside-fixture" },
    "read-inside": { args: { path: readPath, offset: 2, limit: 1 }, target: readPath, result: "read-fixture" },
    "read-absolute-inside": { args: { path: join(cwd, readPath), offset: 2, limit: 1 }, target: join(cwd, readPath), result: "read-fixture" },
    "read-file-link": { args: { path: "file-link" }, target: "file-link", result: "outside-fixture" },
    "read-dir-link": { args: { path: "dir-link/outside.txt" }, target: "dir-link/outside.txt", result: "outside-fixture" },
    "read-hard-link": { args: { path: "hard-link" }, target: "hard-link", result: "outside-fixture" },
    "read-parent": { args: { path: "../outside.txt" }, target: "../outside.txt", result: "outside-fixture" },
    "read-large": { args: { path: "large.txt" }, target: "large.txt", result: "" },
    "read-binary": { args: { path: "binary" }, target: "binary", result: "" },
    "read-fifo": { args: { path: "read-fifo" }, target: "read-fifo", result: "" },
    write: { args: { path: "write.txt", content: "write-fixture" }, target: "write.txt", result: "write.txt" },
    edit: { args: { path: "edit.txt", edits: [{ oldText: "before", newText: "edit-fixture" }] }, target: "edit.txt", result: "edit.txt" },
    bash: { args: { command }, target: command, result: "(no output)" },
  }
  type Operation = keyof typeof operations
  const toolName = (name: Operation) => name.startsWith("read") ? "read" : name
  const cases = new Map<string, { name: Operation; verdict?: Verdict | "exempt" }>()
  decoy(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultModel: foreign, sessionDir: foreignSessionDir }))
  decoy(join(cwd, ".pi", "SYSTEM.md"), foreign)
  const projectMarker = join(dir, "project-extension.marker")
  const globalMarker = join(dir, "global-extension.marker")
  const terminalAgent = join(home, ".pi", "agent")
  const fixtureExtension = (marker: string) => `export default () => Bun.write(${JSON.stringify(marker)}, "loaded")`
  decoy(join(cwd, ".pi", "extensions", "fixture.ts"), fixtureExtension(projectMarker))
  decoy(join(terminalAgent, "extensions", "fixture.ts"), fixtureExtension(globalMarker))
  decoy(join(terminalAgent, "settings.json"), JSON.stringify({ defaultModel: foreign }))
  decoy(join(terminalAgent, "auth.json"), JSON.stringify({ loopback: { type: "api_key", key: foreign } }))
  decoy(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
  decoy(join(cwd, "preload.ts"), `await Bun.write(${JSON.stringify(preload)}, "preload\n")`)
  decoy(join(cwd, ".env"), `PI_SESSION_DIR=${foreignSessionDir}\n`)
  decoy(foreignSession, JSON.stringify({ type: "session", version: 3, id: foreignId, cwd }) + "\n")
  decoy(join(home, ".pi", "pi-acp", "session-map.json"), JSON.stringify({ version: 1, sessions: {
    [foreignId]: { sessionId: foreignId, cwd, sessionFile: foreignSession, updatedAt: new Date().toISOString() },
  } }))
  // 専用ディレクトリに置いただけのセッションも、内部 map に記録がなければ再開しない。
  const unrecordedFile = join(sessions, "unrecorded.jsonl")
  decoy(unrecordedFile, JSON.stringify({ type: "session", version: 3, id: unrecorded, cwd }) + "\n")

  const logs: { msg: string; fields: Record<string, unknown> }[] = []
  const log: Log = { info: (msg, fields = {}) => logs.push({ msg, fields }), error: (msg, fields = {}) => logs.push({ msg, fields }) }
  const access = new AccessStore(join(dir, "access.json"))
  access.save({ allowFrom: [], rooms: { [room]: { receive: "all", allowFrom: [] } }, pending: {} })
  const relay = new Relay(access, log, cwd)
  const sent: { to: string; text: string }[] = []
  relay.addConnector({
    service: "fake", label: "試験コネクター", capabilities: { text: { max: 2000, parts: 1 } },
    async start() {}, stop() {}, async send(to, text) { sent.push({ to, text }); return [`sent-${sent.length}`] },
    async sendApproval() { assert.fail("チャット用ツールは実行承認を求めない") },
    async notice() { return true }, async download() { return [] }, async roomName() { return "試験ルーム" },
  })
  const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")]
  const mcp = tokens.map(token => mcpHandler(relay, join(dir, "inbox"), token))
  let index = 0
  let inheritSettings = false
  let modelRequests = 0
  const approvals: PermissionRequest[] = []
  let approvalWait: { received: PromiseWithResolvers<PermissionRequest>; answer: PromiseWithResolvers<Verdict> } | undefined
  const modelErrors: unknown[] = []
  const requests: { method: string; tool?: string; accepted: boolean; index: number }[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === "/mcp") {
      if (req.method !== "POST") return mcp[index]!(req)
      const { method, params } = await req.clone().json() as { method: string; params?: { name?: string } }
      const res = await mcp[index]!(req)
      requests.push({ method, tool: params?.name, accepted: res.ok, index })
      return res
    }
    if (path !== "/v1/chat/completions") return new Response(null, { status: 404 })
    try {
      const raw = await req.text()
      assert(!tokens.some(token => raw.includes(token)))
      assert.equal(raw.includes(foreign), inheritSettings)
      assert(req.headers.get("authorization") === `Bearer ${auth}`)
      const body = JSON.parse(raw) as {
        model: string
        tools: { function: { name: string; parameters: { required: string[] } } }[]
        messages: { role: string; content: string | { text: string }[]; tool_call_id?: string }[]
      }
      assert.equal(body.model, "fixed")
      assert.deepEqual(body.tools.map(t => t.function.name).sort(), [
        "bash", "edit", "mcp__chat__download_attachment", "mcp__chat__fetch_messages", "mcp__chat__list_rooms", "mcp__chat__reply", "read", "write",
      ])
      const reply = body.tools.find(t => t.function.name === "mcp__chat__reply")!
      assert.deepEqual(reply.function.parameters.required.slice().sort(), ["chat_id", "text"])
      const users = body.messages.filter(m => m.role === "user").map(m =>
        typeof m.content === "string" ? m.content : m.content.map(part => part.text).join(""),
      )
      const text = users.at(-1)!
      const selected = cases.get(text)
      const chat = inheritSettings ? "chat-inherit" : index === 0 ? "chat-new" : "chat-load"
      assert(selected || text === chat)
      if (index === 1) assert(users.includes("chat-new"))
      const id = `call-${text}`
      const last = body.messages.at(-1)
      const result = last?.role === "tool"
      modelRequests++
      if (result) {
        assert.equal(last.tool_call_id, id)
        const output = JSON.stringify(last.content)
        if (!selected) assert(output.includes(`sent (id: sent-${inheritSettings ? 3 : index + 1})`))
        else if (selected.verdict === "allow" || selected.verdict === "exempt") {
          assert(!output.includes("実行が許可されませんでした"))
          assert(output.includes(operations[selected.name].result), output)
          if (selected.name.endsWith("inside")) assert(!output.includes("first line") && !output.includes("last line"), output)
        } else {
          assert(output.includes("実行が許可されませんでした"), output)
          assert(!output.includes("outside-fixture"), output)
        }
      }
      const delta = result ? { role: "assistant", content: `done ${text}` } : {
        role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: {
          name: selected ? toolName(selected.name) : reply.function.name,
          arguments: JSON.stringify(selected ? operations[selected.name].args : { chat_id: room, text }),
        } }],
      }
      const chunk = (d: object, finish_reason: string | null) => JSON.stringify({
        id: `fixture-${modelRequests}`, model: "fixed", object: "chat.completion.chunk", created: 1,
        choices: [{ index: 0, delta: d, finish_reason }],
      })
      return new Response(`data: ${chunk(delta, null)}\n\ndata: ${chunk({}, result ? "stop" : "tool_calls")}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    } catch (err) {
      modelErrors.push(err)
      return new Response("fixture assertion", { status: 400 })
    }
  } })
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: "loopback", defaultModel: "fixed" }), { mode: 0o600 })
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ loopback: { type: "api_key", key: auth } }), { mode: 0o600 })
  writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { loopback: {
    api: "openai-completions", baseUrl: `${server.url.origin}/v1`,
    models: [{ id: "fixed", name: "Fixed loopback", input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
  } } }), { mode: 0o600 })
  const fixtureEnv = { HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_SESSION_DIR: foreignSessionDir, BASH_ENV: join(cwd, "unused.sh"), RELAY_PI_FIXTURE_SECRET: "dummy-not-for-pi" }
  const priorEnv = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]))
  const launch = async (token: string, sessionId?: string, workspace = cwd) => {
    const start = preparePiLaunch({
      home: relayHome, cwd: workspace, options: { inheritSettings, memory: false }, stderrPath, sessionId,
    }, log)
    return start({ url: `${server.url.origin}/mcp`, token }, async req => {
      approvals.push(req)
      approvalWait?.received.resolve(req)
      return approvalWait ? approvalWait.answer.promise : "deny"
    })
  }
  let live: Awaited<ReturnType<typeof launch>> | undefined
  async function stop() {
    if (!live) return
    live.stop()
    await live.exited
    live = undefined
  }
  function startOperation(name: Operation, verdict?: Verdict) {
    const text = `tool-${index}-${name}-${verdict ?? "disconnect"}`
    const received = Promise.withResolvers<PermissionRequest>()
    const answer = Promise.withResolvers<Verdict>()
    cases.set(text, { name, verdict })
    approvalWait = { received, answer }
    const prompt = live!.session.prompt(text)
    // 切断の場合など、承認待ちと並行して prompt が終了しても未処理の reject にしない。
    void prompt.catch(() => {})
    return { request: Promise.race([received.promise, prompt.then(() => assert.fail("承認なしでターンが終わりました"))]), answer, prompt }
  }

  function checkState(name: Operation, allowed: boolean) {
    if (name !== "write" && name !== "edit" && name !== "bash") return // モデルに届いた結果で確認する。
    const path = join(cwd, name === "bash" ? "shell.txt" : operations[name].target)
    if (allowed) assert.equal(readFileSync(path, "utf8"), { write: "write-fixture", edit: "edit-fixture", bash: "shell-fixture" }[name])
    else if (name === "edit") assert.equal(readFileSync(path, "utf8"), "before")
    else assert(!existsSync(path))
  }

  async function checkApprovals() {
    const before = approvals.length
    for (const name of ["read-inside", "read-absolute-inside"] as const) {
      if (process.platform !== "darwin") continue
      const text = `tool-${index}-${name}-exempt`
      cases.set(text, { name, verdict: "exempt" })
      await live!.session.prompt(text)
      if (modelErrors.length) throw modelErrors[0]
      assert.equal(approvals.length, before)
    }
    const casesRequiringApproval: Operation[] = [
      "read", "write", "edit", "bash", "read-file-link", "read-dir-link", "read-hard-link", "read-parent", "read-large", "read-binary", "read-fifo",
    ]
    if (process.platform !== "darwin") casesRequiringApproval.push("read-inside", "read-absolute-inside")
    let expected = before
    for (const name of casesRequiringApproval) {
      if (name === "edit") writeFileSync(join(cwd, "edit.txt"), "before")
      const verdicts = ["read", "write", "edit", "bash"].includes(name) ? ["deny", "allow"] as const : ["deny"] as const
      for (const verdict of verdicts) {
        const op = startOperation(name, verdict)
        const req = await op.request
        expected++
        assert(req.title.startsWith(`${toolName(name)}：`), req.title)
        assert.deepEqual(JSON.parse(req.input), {
          method: "confirm", title: req.title,
          message: `${name === "bash" ? "コマンド" : "対象パス"}: ${JSON.stringify(operations[name].target)}`,
        })
        assert.equal(req.always, undefined)
        assert.equal(req.requireFullDisplay, true)
        checkState(name, false)
        op.answer.resolve(verdict)
        await op.prompt
        if (modelErrors.length) throw modelErrors[0]
        checkState(name, verdict === "allow")
      }
    }
    assert.equal(approvals.length, expected)
    approvalWait = undefined
    for (const name of ["write.txt", "edit.txt", "shell.txt"]) rmSync(join(cwd, name))
  }

  try {
    Object.assign(process.env, fixtureEnv)
    live = await launch(tokens[0]!)
    const started = logs.find(({ fields }) => fields.start === "new")?.fields
    assert.equal(started?.version, "0.0.34")
    const sessionId = started?.sessionId
    assert(typeof sessionId === "string")
    assert.equal(live.sessionId, sessionId)
    const records = join(relayHome, "pi", "registered-sessions")
    assert.deepEqual(JSON.parse(readFileSync(join(records, `${sessionId}.json`), "utf8")), { harness: "pi", workspace: cwd, sessionId })
    await live.session.prompt("chat-new")
    if (modelErrors.length) throw modelErrors[0]
    assert.deepEqual(sent, [{ to: room, text: "chat-new" }])
    assert.equal(approvals.length, 0)
    await checkApprovals()
    const approvedRequests = approvals.length
    const outputCount = logs.filter(({ fields }) => typeof fields.text === "string").length
    await stop()

    index = 1
    live = await launch(tokens[1]!, sessionId)
    assert(logs.some(({ fields }) => fields.start === "load" && fields.sessionId === sessionId))
    assert.equal(logs.filter(({ fields }) => typeof fields.text === "string").length, outputCount)
    await live.session.prompt("chat-load")
    if (modelErrors.length) throw modelErrors[0]
    assert.deepEqual(sent, [{ to: room, text: "chat-new" }, { to: room, text: "chat-load" }])
    assert.equal(approvals.length, approvedRequests)
    await checkApprovals()
    assert.equal(approvals.length, 2 * approvedRequests)
    const completedRequests = modelRequests
    const disconnected = startOperation("write")
    assert((await disconnected.request).title.startsWith("write："))
    checkState("write", false)
    await stop()
    disconnected.answer.resolve("allow")
    await assert.rejects(disconnected.prompt)
    checkState("write", false)
    approvalWait = undefined
    for (const i of [0, 1]) assert.deepEqual(requests.filter(r => r.index === i).map(r => [r.method, r.tool, r.accepted]), [
      ["initialize", undefined, true], ["notifications/initialized", undefined, true], ["tools/list", undefined, true], ["tools/call", "reply", true],
    ])

    const mapPath = join(agent, "pi-acp-session-map.json")
    const map = readFileSync(mapPath, "utf8")
    const parsed = JSON.parse(map) as { sessions: Record<string, unknown> }
    assert.deepEqual(Object.keys(parsed.sessions), [sessionId])
    // pi-acp の内部対応表にあっても、中継の台帳にないセッションは再開しない。
    parsed.sessions[unrecorded] = { sessionId: unrecorded, cwd, sessionFile: unrecordedFile, updatedAt: new Date().toISOString() }
    writeFileSync(mapPath, JSON.stringify(parsed))
    for (const id of [foreignId, unrecorded]) await assert.rejects(() => launch(tokens[1]!, id), /中継が作った pi のセッションに限って/)
    await assert.rejects(() => launch(tokens[1]!, sessionId, otherCwd), /中継が作った pi のセッションに限って/)
    writeFileSync(mapPath, map)
    await assert.rejects(() => launch(tokens[0]!), /Managed chat MCP did not become ready/)
    await assert.rejects(() => launch(tokens[0]!, sessionId), /Managed chat MCP did not become ready/)
    assert.deepEqual(requests.slice(8).map(r => [r.method, r.accepted]), [["initialize", false], ["initialize", false]])
    assert.equal(modelRequests, completedRequests + 1)
    assert(!existsSync(preload) && !existsSync(projectMarker) && !existsSync(globalMarker))
    for (const [path, text] of decoys) assert.equal(readFileSync(path, "utf8"), text)
    const saved = readdirSync(sessions).filter(name => name.endsWith(".jsonl") && name !== "unrecorded.jsonl")
    assert.equal(saved.length, 1)
    const transcript = readFileSync(join(sessions, saved[0]!), "utf8")
    assert.equal((JSON.parse(transcript.split("\n")[0]!) as { cwd: string }).cwd, cwd)
    assert.deepEqual(readdirSync(records), [`${sessionId}.json`])
    for (const text of [transcript, map, JSON.stringify(logs), readFileSync(stderrPath, "utf8")]) {
      assert(!tokens.some(token => text.includes(token)))
      assert(!text.includes(auth))
      assert(!text.includes(foreign))
    }

    inheritSettings = true
    live = await launch(tokens[1]!, sessionId)
    assert(logs.some(({ msg }) => msg.includes("警告：pi の端末・プロジェクト設定を引き継ぎます")))
    assert.equal(readFileSync(projectMarker, "utf8"), "loaded")
    assert.equal(readFileSync(globalMarker, "utf8"), "loaded")
    assert(!existsSync(preload))
    await live.session.prompt("chat-inherit")
    if (modelErrors.length) throw modelErrors[0]
    assert.deepEqual(sent.at(-1), { to: room, text: "chat-inherit" })
    assert.equal(approvals.length, 2 * approvedRequests + 1)
    // 設定を継承しても、中継は書き込みに今回の承認を求める。
    const op = startOperation("write", "deny")
    assert((await op.request).title.startsWith("write："))
    op.answer.resolve("deny")
    await op.prompt
    if (modelErrors.length) throw modelErrors[0]
    checkState("write", false)
    assert.deepEqual(readdirSync(records), [`${sessionId}.json`])
    for (const [path, value] of decoys) assert.equal(readFileSync(path, "utf8"), value)
    await stop()

    // 公開 CLI の再開経路も通す。LINE はローカルの Webhook を待つだけで、外には接続しない。
    const cli = Bun.spawn([join(src, "..", "bin", "agent-chat-relay"), "serve", "pi", "--workspace", cwd, "--session-id", sessionId], {
      cwd,
      env: { PATH: [dirname(BUN_ISOLATED[0]!), "/usr/bin", "/bin"].join(delimiter),
        HOME: home, RELAY_HOME: relayHome, RELAY_HTTP_PORT: "0", RELAY_MCP_PORT: "0",
        RELAY_LINE_CHANNEL_SECRET: "dummy-secret", RELAY_LINE_CHANNEL_TOKEN: "dummy-token", RELAY_LINE_API_BASE: server.url.origin },
      stdout: "pipe", stderr: "pipe",
    })
    const stderr = new Response(cli.stderr).text()
    const timeout = setTimeout(() => cli.kill("SIGKILL"), 15_000)
    let stdout = ""
    try {
      for await (const chunk of cli.stdout) {
        stdout += Buffer.from(chunk).toString("utf8")
        if (/"start":"load"/.test(stdout)) break
      }
      if (!stdout.includes(`"sessionId":"${sessionId}"`) || !stdout.includes('"start":"load"')) {
        assert.fail(`公開 CLI で再開できませんでした: ${await stderr}`)
      }
    } finally {
      cli.kill()
      await cli.exited
      clearTimeout(timeout)
    }
  } finally {
    for (const [key, val] of Object.entries(priorEnv)) {
      if (val === undefined) delete process.env[key]
      else process.env[key] = val
    }
    approvalWait?.answer.resolve("deny")
    await stop()
    await server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}, 45_000)
