// pi CLI を通さず、明示した中継専用のサービスで SDK の RPC を動かす。
import { readFileSync, realpathSync, statSync } from "node:fs"
import { isAbsolute, join, relative, sep } from "node:path"
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, runRpcMode, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { z } from "zod"
import { managedChat, managedExtensionName, managedToolSelection } from "./managed-extension.ts"

const chatInput = z.object({
  url: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]+\/mcp$/),
  authorization: z.string().regex(/^Bearer [A-Za-z0-9_-]{43}$/),
})
const modelSettings = z.object({ defaultProvider: z.string().min(1), defaultModel: z.string().min(1) })
const relayPrompt = "あなたはチャット中継を通じて会話するアシスタントです。ルームへの返事には mcp__chat__reply を使います。"

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function directory(path: string | undefined): string {
  if (!path || !isAbsolute(path)) throw new Error()
  const real = realpathSync(path)
  if (!statSync(real).isDirectory()) throw new Error()
  return real
}

function openSession(workspace: string, stateDir: string): SessionManager {
  const args = process.argv.slice(2)
  if (!args.length) return SessionManager.create(workspace, stateDir)
  const [flag, file] = args
  if (args.length !== 2 || flag !== "--session" || !file || !isAbsolute(file)) throw new Error()
  const target = realpathSync(file)
  if (!inside(stateDir, target) || !statSync(target).isFile()) throw new Error()
  const session = SessionManager.open(target)
  if (session.getCwd() !== workspace) throw new Error()
  return session
}

async function start(): Promise<void> {
  const workspace = directory(process.env.PI_ACP_MANAGED_CHAT_WORKSPACE)
  const agentDir = directory(process.env.PI_CODING_AGENT_DIR)
  const stateDir = directory(join(agentDir, "sessions"))
  if (process.cwd() !== workspace || workspace === agentDir || inside(workspace, agentDir) || inside(agentDir, workspace) || !inside(agentDir, stateDir)) {
    throw new Error()
  }
  const sessionManager = openSession(workspace, stateDir)
  // MCP の認証ヘッダーを引数・環境変数・RPC の行には載せない。
  const mcp = chatInput.parse(JSON.parse(await Bun.file(3).text()))
  const { defaultProvider, defaultModel } = modelSettings.parse(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")))
  const inherited = process.env.PI_ACP_INHERITED_AGENT_DIR
  if (inherited !== undefined && !isAbsolute(inherited)) throw new Error()
  const runtime = await createAgentSessionRuntime(async options => {
    if (options.cwd !== workspace || options.sessionManager !== sessionManager) throw new Error()
    const source = inherited === undefined ? undefined : SettingsManager.create(workspace, inherited, { projectTrusted: true })
    if (source?.drainErrors().length) throw new Error()
    const services = await createAgentSessionServices({
      cwd: workspace,
      agentDir: inherited ?? agentDir,
      modelRuntime: await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }),
      // 継承するのは設定の値だけ。SDK から端末やプロジェクトの settings.json へは保存しない。
      settingsManager: SettingsManager.inMemory({
        ...source?.getSettings(), defaultProvider, defaultModel, enableSkillCommands: false,
        // 承認依頼で示したコマンドに、設定由来のコマンドを付け足さない。
        shellCommandPrefix: "",
        ...(!source ? { compaction: { enabled: false }, retry: { enabled: false } } : {}),
      }, { projectTrusted: source !== undefined }),
      resourceLoaderOptions: {
        ...(!source ? {
          noContextFiles: true, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          systemPrompt: relayPrompt, appendSystemPrompt: [],
        } : { appendSystemPromptOverride: entries => [...entries, relayPrompt] }),
        disabledBuiltinExtensions: ["mcp"],
        extensionFactories: [{ name: managedExtensionName, factory: managedChat(mcp, workspace, stateDir) }],
      },
    })
    const model = services.modelRuntime.getModel(defaultProvider, defaultModel)
    if (!model || !services.modelRuntime.hasConfiguredAuth(defaultProvider) || services.diagnostics.length || services.resourceLoader.getExtensions().errors.length) {
      throw new Error()
    }
    return {
      ...await createAgentSessionFromServices({ ...options, services, model, scopedModels: [{ model }], tools: managedToolSelection }),
      services,
      diagnostics: [],
    }
  }, { cwd: workspace, agentDir, sessionManager })
  await runRpcMode(runtime)
}

if (import.meta.main) {
  await start().catch(() => {
    // ファイル・認証・HTTP リクエストに由来する値をログに出さない。
    process.stderr.write("Managed Pi RPC failed to start or run\n")
    process.exitCode = 1
  })
}
