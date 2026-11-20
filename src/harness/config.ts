// ハーネスごとの起動方法。実行承認と設定の読み込みに関わる部分は安全境界（AGENTS.md、ADR 0017）。

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { HarnessConfig } from "./harness.ts"
import type { HarnessName } from "../serve-args.ts"
import type { Log } from "../core/relay.ts"

/**
 * Bun で別のプログラムを動かすときの先頭部分。Bun は、cwd の .env を環境変数に読み込み、cwd の bunfig.toml の preload を実行する。
 * cwd は作業ディレクトリで、エージェントが書けるか、管理者のプロジェクトの .env がありうるので、どちらも読ませない（ADR 0019）
 */
export const BUN_ISOLATED = [process.execPath, "--no-env-file", "--config=/dev/null"]

/** claude-agent-acp の入り口。起動したディレクトリではなく、このパッケージの依存から探す */
const ADAPTER = fileURLToPath(import.meta.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"))

/**
 * Claude Code に読み込ませない指示のファイル。CLAUDE.local.md と .claude/rules/ も、上位のディレクトリから読まれる
 * （Claude Code 2.1.327 で、CLAUDE.md・AGENTS.md だけを除くと、この 2 つが残ることを確認した）
 */
export const CLAUDE_MD_EXCLUDES = ["**/AGENTS.md", "**/CLAUDE.md", "**/CLAUDE.local.md", "**/.claude/rules/**"]

/** 管理者が環境変数で選ぶ、ハーネスの設定の読み込み（ADR 0017） */
export type HarnessOptions = {
  /** RELAY_HARNESS_SETTINGS=default。ユーザー設定・CLAUDE.md などを、その環境の既定どおりに読ませる */
  inheritSettings: boolean
  /** RELAY_HARNESS_MEMORY=1。自動メモリを有効にする */
  memory: boolean
}

/** 決めた値以外は、書き間違いとして起動しない。空の値は指定なしとして扱う */
export function harnessOptionsFromEnv(env: Record<string, string | undefined>): HarnessOptions {
  return {
    inheritSettings: flag(env, "RELAY_HARNESS_SETTINGS", "default"),
    memory: flag(env, "RELAY_HARNESS_MEMORY", "1"),
  }
}

function flag(env: Record<string, string | undefined>, name: string, on: string): boolean {
  const v = env[name]
  if (!v) return false
  if (v !== on) throw new Error(`${name} に指定できるのは ${on} だけです（今は ${JSON.stringify(v)}）`)
  return true
}

export function harnessConfig(
  name: Exclude<HarnessName, "pi">,
  cwd: string,
  mcp: HarnessConfig["mcp"],
  opts: HarnessOptions,
  log: Log,
  /** 管理者が指定した作業ディレクトリ（RELAY_WORKSPACE）か。中継専用でなければ、管理者のファイルを上書きしない */
  specified = false,
  env: Record<string, string | undefined> = process.env,
): Omit<HarnessConfig, "stderrPath"> {
  switch (name) {
    case "claude": {
      const claude = Bun.which("claude", { PATH: env.PATH ?? "" })
      if (!claude) throw new Error("claude が見つかりません")
      return {
        // Agent SDK に同梱の CLI ではなく、インストール済みの claude を使う
        command: [...BUN_ISOLATED, ADAPTER],
        env: { CLAUDE_CODE_EXECUTABLE: claude },
        cwd,
        mcp,
        mode: "default",
        meta: { claudeCode: { options: claudeOptions(opts) } },
      }
    }
    case "opencode": {
      // 今は実行承認が働かない（#6）。安全境界を割るので、明示しない限り起動しない
      if (env.RELAY_ALLOW_UNSAFE_HARNESS !== "1") {
        throw new Error("opencode では実行承認が働かない（#6）ため、RELAY_ALLOW_UNSAFE_HARNESS=1 がないと起動しません")
      }
      // OpenCode は今もユーザーの設定を読み、自動メモリもない
      if (opts.inheritSettings || opts.memory) log.info("RELAY_HARNESS_SETTINGS・RELAY_HARNESS_MEMORY は、opencode には効きません")
      writeOpencodeConfig(cwd, env.RELAY_OPENCODE_MODEL, specified)
      return { command: ["opencode", "acp"], cwd, mcp }
    }
  }
}

/** Claude Code の Agent SDK の options。指定のない項目は、その環境の claude の既定になる */
export function claudeOptions(opts: HarnessOptions): Record<string, unknown> {
  return {
    // ユーザー設定（~/.claude/settings.json）の allow ルールや hooks を読み込ませない
    ...(opts.inheritSettings ? {} : { settingSources: ["project", "local"] }),
    settings: {
      // ユーザーや上位ディレクトリの CLAUDE.md・AGENTS.md などを読み込ませない
      ...(opts.inheritSettings ? {} : { claudeMdExcludes: CLAUDE_MD_EXCLUDES }),
      // ユーザー設定で切っていても、指定があれば有効にする（ここで渡す値は、ユーザー・project の設定より優先される）
      autoMemoryEnabled: opts.memory,
      // ツールを実行するたびに承認を求める。指定しないと、claude-agent-acp は auto モード（分類器による自動承認）で始める。
      // mcp__chat だけは承認なし（送り先は中継が、登録したルームと許可した DM に限る。ADR 0008）。
      // どちらも、設定の読み込みを管理者の環境に合わせても外さない（ADR 0017）
      permissions: { defaultMode: "default", allow: ["mcp__chat"] },
    },
  }
}

/**
 * 作業ディレクトリに opencode.json を書く。管理者が指定した作業ディレクトリでは、管理者の書いた設定を上書きしない（ADR 0017）。
 * そこでは、前回の起動で中継が書いたもの（中身が同じもの）だけを、そのまま使う
 */
function writeOpencodeConfig(cwd: string, model: string | undefined, specified: boolean): void {
  // 既定ではほぼすべてを承認なしで実行するので、すべて尋ねたうえで、読み取りとチャット用ツールだけを許す。
  // 組み込みの build エージェントの規則（* を許可）より後に効くよう、エージェントの規則として書く（後の規則ほど優先される）
  const config = {
    $schema: "https://opencode.ai/config.json",
    ...(model ? { model } : {}),
    agents: {
      build: {
        permissions: [
          { action: "*", resource: "*", effect: "ask" },
          ...["read", "glob", "grep", "subagent"].map((action) => ({ action, resource: "*", effect: "allow" })),
          { action: "chat_*", resource: "*", effect: "allow" },
          // 選択肢での質問は中継しない。チャットで尋ねさせる
          { action: "question", resource: "*", effect: "deny" },
          // 作業ディレクトリの外は、読み取りでも尋ねる
          { action: "external_directory", resource: "*", effect: "ask" },
        ],
      },
    },
  }
  const text = JSON.stringify(config, null, 2) + "\n"
  const path = join(cwd, "opencode.json")
  if (specified) {
    // opencode.jsonc は、中継の書く権限の設定より優先されるかもしれない（未確認）
    if (existsSync(join(cwd, "opencode.jsonc"))) throw new Error(`作業ディレクトリに opencode.jsonc があるため、起動しません: ${cwd}`)
    if (existsSync(path) && readFileSync(path, "utf8") !== text) {
      throw new Error(`作業ディレクトリの opencode.json が中継の書く内容と違うため、起動しません（上書きしません。中継が前回書いたものなら、消してから起動してください）: ${path}`)
    }
  }
  writeFileSync(path, text)
}
