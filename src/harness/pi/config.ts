import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { Log, PermissionRequest, Verdict } from "../../core/relay.ts"
import { BUN_ISOLATED, type HarnessOptions } from "../config.ts"
import { startHarness, type HarnessConfig } from "../harness.ts"
import { preparePiState } from "./state.ts"

const ADAPTER = fileURLToPath(new URL("../../vendor/pi/adapter.js", import.meta.url))

type PiLaunch = Pick<HarnessConfig, "cwd" | "sessionId" | "stderrPath"> & { home: string; options: HarnessOptions }

/** コネクターを起動する前に設定・台帳を確認する。 */
export function preparePiLaunch({ home, options, cwd, sessionId, stderrPath }: PiLaunch, log: Log) {
  if (options.memory) throw new Error("pi では自動メモリを指定できません")
  const state = preparePiState(home, cwd)
  if (sessionId !== undefined) state.requireSession(sessionId)
  state.checkModelFiles()
  const inherited = options.inheritSettings ? resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")) : undefined
  return async (mcp: HarnessConfig["mcp"], onPermission: (req: PermissionRequest) => Promise<Verdict>) => {
    if (inherited) log.error("警告：pi の端末・プロジェクト設定を引き継ぎます。信頼済みの拡張などが実行承認を通らずに動くことがあります")
    const launched = await startHarness({
      command: [...BUN_ISOLATED, ADAPTER],
      cwd: state.workspace, mcp, sessionId, stderrPath,
      inheritEnv: false,
      env: {
        HOME: state.childHome,
        PATH: "/usr/bin:/bin",
        TMPDIR: state.temp,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_ACP_MANAGED_CHAT_WORKSPACE: state.workspace,
        PI_CODING_AGENT_DIR: state.agentDir,
        ...(inherited ? { PI_ACP_INHERITED_AGENT_DIR: inherited } : {}),
      },
    }, onPermission, log)
    if (sessionId === undefined) {
      try {
        state.registerSession(launched.sessionId)
      } catch {
        launched.stop()
        await launched.exited
        throw new Error("中継の pi セッション台帳に記録できませんでした")
      }
    }
    return launched
  }
}
