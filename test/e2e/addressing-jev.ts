// 評価：受信モードが「他人宛てを除く（Jev）」のルームで、Jev が、どの発言を他人宛てとして外すか（ADR 0029。結果は docs/addressing-eval.md）。
// 評価の会話（test/e2e/conversations.ts）の、メンションのない発言を 1 つずつ、実際の Jev に問い合わせる。中継と同じ要求（src/jev.ts の screenRequest）を送る。
// 直前の発言には、それより前の発言と Bot の返事（Line.bot）を入れる。費用は入力トークンの分だけで、1 回で 1 円もかからない。
//
//   scripts/jev-eval.sh [--check]
//
// 結果の全件は test/fixtures/addressing-jev.json に書き、表を標準出力に出す。
// --check は、答えるべき発言を 1 つでも外したら 0 以外で終わる

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ScreenMessage } from "../../src/core/relay.ts"
import { screenFromEnv } from "../../src/jev.ts"
import { HOLDOUT, JEV_EXTRA, MAIN, NAMES, USERS, type Line, type Want } from "./conversations.ts"

const SETS = { main: MAIN, holdout: HOLDOUT, extra: JEV_EXTRA }
type Row = { set: string; index: number; name: string; text: string; want: Want; drop: boolean | undefined; probabilities?: Record<string, number>; ms: number }
/** 同時に問い合わせる数。中継では、発言ごとに 1 つずつ問い合わせる */
const CONCURRENCY = Number(process.env.JEV_EVAL_CONCURRENCY ?? 1)

const BOT = { sender: "bot", name: "", fromMe: true }
const message = (l: Line): ScreenMessage => ({ sender: USERS[l.user], name: NAMES[l.user], fromMe: false, text: l.text })

async function evaluate(): Promise<Row[]> {
  const errors: string[] = []
  const log = { info: () => {}, error: (m: string, e?: Record<string, unknown>) => void errors.push(`${m} ${JSON.stringify(e ?? {})}`) }
  const screen = screenFromEnv(process.env, log)
  if (!screen) throw new Error("RELAY_TYPESAFE_API_KEY がありません（scripts/jev-eval.sh から動かしてください）")
  const jobs: (() => Promise<Row>)[] = []
  for (const [set, conversation] of Object.entries(SETS)) {
    const recent: ScreenMessage[] = []
    conversation.forEach((l, index) => {
      // メンションのある発言は、Jev に問い合わせずに渡す
      if (!l.mention) {
        const q = { service: "LINE", room: "開発チーム", recent: [...recent], message: message(l) }
        jobs.push(async () => {
          const start = performance.now()
          const r = await screen(q)
          return { set, index, name: NAMES[l.user], text: l.text, want: l.want, drop: r?.drop, probabilities: r?.probabilities, ms: Math.round(performance.now() - start) }
        })
      }
      recent.push(message(l))
      if (l.bot) recent.push({ ...BOT, text: l.bot })
    })
  }
  const rows: Row[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < jobs.length) {
        const i = next++
        rows[i] = await jobs[i]!()
      }
    }),
  )
  for (const e of errors) console.error(e)
  return rows
}

function report(rows: Row[]): string {
  const out: string[] = []
  const count = (want: Want) => {
    const r = rows.filter((x) => x.want === want)
    return `${r.filter((x) => x.drop).length}/${r.length}`
  }
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b)
  out.push(`かかった時間：中央値 ${ms[Math.floor(ms.length / 2)]} ms、最大 ${ms.at(-1)} ms`, "")
  out.push("| 外した発言 | 答えるべき発言 | 黙るべき発言 | どちらでもよい発言 |", "|---|---|---|---|", `| 数 | ${count("answer")} | ${count("silent")} | ${count("either")} |`, "")
  out.push("| 会話 | # | 発言 | 正解 | agent | other | answers_agent | 外した | ms |", "|---|---|---|---|---|---|---|---|---|")
  for (const r of rows) {
    const p = r.probabilities ?? {}
    const f = (k: string) => (p[k] === undefined ? "" : p[k]!.toFixed(2))
    const want = { answer: "答える", silent: "黙る", either: "どちらでも" }[r.want]
    out.push(`| ${r.set} | ${r.index + 1} | ${r.name}：${r.text.replace(/\|/g, "\\|")} | ${want} | ${f("agent")} | ${f("other")} | ${f("answersAgent")} | ${r.drop ? "外した" : r.drop === undefined ? "失敗（渡す）" : ""} | ${r.ms} |`)
  }
  return out.join("\n")
}

if (import.meta.main) {
  const rows = await evaluate()
  writeFileSync(join(import.meta.dir, "../fixtures/addressing-jev.json"), JSON.stringify({ date: new Date().toISOString().slice(0, 10), rows }, null, 2) + "\n")
  console.log(report(rows))
  const wrong = rows.filter((r) => r.want === "answer" && r.drop)
  for (const r of wrong) console.log(`NG: 答えるべき発言を外しました（${r.set} の ${r.index + 1}：${r.text}）`)
  if (process.argv.includes("--check") && wrong.length) process.exit(1)
}
