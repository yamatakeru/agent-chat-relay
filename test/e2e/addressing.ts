// 評価：受信モードが「すべて」のルームで、メンションのない発言に、エージェントが答えるか・黙るか（#107。結果は docs/addressing-eval.md）。
// 正解を付けた会話を、実際の Claude Code と LINE の API のモック（test/e2e/mock-line.ts）に流す。契約の利用枠を使う。
//
//   mise exec -- bun --no-env-file --config=/dev/null test/e2e/addressing.ts run <ラベル> [--set main|holdout] [--root <中継のディレクトリ>] [--runs 3] [--port 18200]
//   mise exec -- bun --no-env-file --config=/dev/null test/e2e/addressing.ts report [--check] <結果の JSON>...
//
// ふだんは test/e2e/addressing.sh から使う。--check は、結果が基準（CHECK）に届かなければ 0 以外で終わる
//
// 会話は 2 つ。main は案内の文面を決めるのに使い、holdout は、文面が main に合わせすぎていないかを、言い回しを変えた別の会話で確かめる。
// モデルは ANTHROPIC_MODEL で選ぶ（なければ Claude Code の既定）。--root で、別のコミットの中継（git worktree など）を動かせる。
// 中継は 3 つのポート（--port から順に、Webhook、MCP、モック）を使うので、同時に走らせるときは --port をずらす。
// 記録と作業ディレクトリは .local/e2e/addressing-<ラベル>/ に、結果は .local/e2e/addressing-<ラベル>.json に書く。
// 発言は、1 つずつ、前のターンが終わってから送る。束（burst）は、1.5 秒ずつ空けて続けて送る（作業中のターンへの差し込みを含む）

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { sign } from "../../src/connectors/http.ts"
import { TURN_NOTICES } from "../../src/core/relay.ts"
import { BUN_ISOLATED } from "../../src/harness/config.ts"

type Want = "answer" | "silent" | "either"
type Line = { user: "A" | "B" | "C"; text: string; want: Want; mention?: boolean; burst?: number }

const USERS = { A: "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", B: "Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", C: "Uccccccccccccccccccccccccccccccccc" }
const NAMES = { A: "アリス", B: "ボブ", C: "カオル" }
const ROOM = "C111aaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

/**
 * 評価用の会話。answer：Bot が答えるべき、silent：黙るべき、either：どちらでもよい（数えない）。
 * answer は、だれに向けたかを書いていない問いかけ、全員や「だれか」に向けた問い、Bot との会話の続き。
 * silent は、名前で特定の人に向けた発言（構造の印はない）、人どうしのやりとり、Bot が役に立てない雑談と相づち
 */
const MAIN: Line[] = [
  { user: "A", text: "今日からこのルームでもよろしくね。", want: "answer", mention: true },
  { user: "B", text: "おはようございます", want: "either" },
  { user: "A", text: "ボブさん、昨日のレビューありがとう", want: "silent" },
  { user: "B", text: "いえいえ、こちらこそ助かりました", want: "silent" },
  { user: "A", text: "Python で辞書をキーの順に並べ替えるのって、どう書くんだっけ？", want: "answer" },
  { user: "B", text: "sorted に items を渡すやつですね", want: "silent" },
  { user: "A", text: "なるほど、ありがとう", want: "either" },
  { user: "C", text: "みんな、UTC の 15 時って日本時間だと何時だっけ？", want: "answer" },
  { user: "A", text: "カオルさん、例の見積もりって今日中に送れそう？", want: "silent" },
  { user: "C", text: "夕方には送ります！", want: "silent" },
  { user: "B", text: "だれか、git で直前のコミットのメッセージだけ直すコマンド覚えてる？", want: "answer" },
  { user: "A", text: "お昼どうする？", want: "silent" },
  { user: "C", text: "そば行きたいです", want: "silent" },
  { user: "A", text: 'この JSON、どこがおかしいんだろう {"a": 1, "b": [2, 3,]}', want: "answer" },
  { user: "A", text: "じゃあ、末尾のカンマを消せば読めるようになる？", want: "answer" },
  { user: "C", text: "アリスさん、その JSON って何に使うやつですか？", want: "silent" },
  { user: "A", text: "デプロイの設定ファイルだよ", want: "silent" },
  { user: "B", text: "ちなみに 1 マイルって何キロだっけ", want: "answer" },
  { user: "C", text: "マイル表記、分かりにくいですよね", want: "silent" },
  { user: "A", text: "ボブさん、来週の休みの件、もう上長に伝えた？", want: "silent" },
  { user: "B", text: "まだです、今日中に伝えます", want: "silent" },
  { user: "B", text: "これ、来週までにだれかやっておいてくれると嬉しいなあ", want: "either" },
  { user: "B", text: "あとで飲み物買ってきます", want: "silent", burst: 1 },
  { user: "A", text: "ありがとう、お茶でお願い", want: "silent", burst: 1 },
  { user: "C", text: "正規表現で、行頭の空白だけ消すのってどう書くんでしたっけ？", want: "answer", burst: 1 },
  { user: "A", text: "カオルさん、それ急ぎ？", want: "silent", burst: 1 },
]

/** main と分類は同じで、言い回しを変え、迷いやすい発言を足した会話 */
const HOLDOUT: Line[] = [
  { user: "B", text: "今日も一日がんばりましょう", want: "either", mention: true },
  { user: "C", text: "今日は暑いですね", want: "silent" },
  { user: "A", text: "ほんとに。エアコン強めにしようかな", want: "silent" },
  { user: "B", text: "これって英語でなんて言うんだっけ、「締め切りを延ばす」", want: "answer" },
  { user: "B", text: "もう少しカジュアルな言い方もある？", want: "answer" },
  { user: "C", text: "ボブさん、それ先方へのメールで使うんですか？", want: "silent" },
  { user: "B", text: "そうそう、午後に送る予定", want: "silent" },
  { user: "A", text: "了解です", want: "silent" },
  { user: "C", text: "計算得意な人いますか？ 2,480 円の 3 割引きっていくら？", want: "answer" },
  { user: "A", text: "カオルさん、それ経費で落ちるやつ？", want: "silent" },
  { user: "C", text: "たぶん大丈夫です", want: "silent" },
  { user: "A", text: "シェルで、カレントディレクトリの中の一番大きいファイルを探すには？", want: "answer" },
  { user: "B", text: "それ、ボットに聞いてみたら？", want: "either" },
  { user: "C", text: "なんでこのビルド、こんなに遅いんだろうね", want: "either" },
  { user: "B", text: "アリスさん、明日の打ち合わせ、10 時からで合ってます？", want: "silent" },
  { user: "A", text: "合ってます！", want: "silent" },
  { user: "C", text: "ねえ、HTTP の 418 ってなんのステータスだっけ", want: "answer" },
  { user: "C", text: "へえ、そんなのあるんだ", want: "silent" },
  { user: "B", text: "今週の金曜、飲み会行ける人？", want: "silent" },
  { user: "A", text: "行きます〜", want: "silent" },
  { user: "B", text: "TypeScript で、配列から重複を取り除く一番短い書き方って？", want: "answer" },
  { user: "A", text: "ボブさん、例の資料あとで見ておきますね", want: "silent", burst: 1 },
  { user: "B", text: "ありがとうございます！", want: "silent", burst: 1 },
  { user: "C", text: "ところで、cron で毎週月曜の朝 9 時って、どう書くんでしたっけ", want: "answer", burst: 1 },
  { user: "A", text: "お先に失礼します", want: "silent", burst: 1 },
]

const SETS = { main: MAIN, holdout: HOLDOUT }
type SetName = keyof typeof SETS

/** 1 回の結果。steps は、束でない発言ごとの返事。bursts は、束ごとの返事 */
type Step = { index: number; want: Want; replies: string[] }
type Burst = { indexes: number[]; answers: number; replies: string[] }
type Run = { steps: Step[]; bursts: Burst[] }
type Result = { label: string; set: SetName; model: string; root: string; runs: Run[] }

const NOTICES: string[] = Object.values(TURN_NOTICES)

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`${what} を待ちきれませんでした`)
    await Bun.sleep(200)
  }
}

async function runOnce(label: string, conversation: Line[], root: string, base: number, dir: string): Promise<Run> {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const home = join(dir, "home")
  const sent = join(dir, "sent.jsonl")
  writeFileSync(sent, "")
  let relayLog = ""
  const env = {
    ...process.env,
    RELAY_HOME: home,
    RELAY_ENV_FILE: join(dir, ".env"),
    RELAY_LINE_API_BASE: `http://127.0.0.1:${base + 2}`,
    RELAY_LINE_CHANNEL_SECRET: "dummysecret",
    RELAY_LINE_CHANNEL_TOKEN: "dummytoken",
    RELAY_PUBLIC_URL: `http://127.0.0.1:${base}`,
    RELAY_HTTP_PORT: String(base),
    RELAY_MCP_PORT: String(base + 1),
    MOCK_LINE_PORT: String(base + 2),
    RELAY_WORKSPACE: undefined,
    RELAY_HARNESS_SETTINGS: undefined,
    RELAY_HARNESS_MEMORY: undefined,
  }
  const mock = Bun.spawn([...BUN_ISOLATED, join(import.meta.dir, "mock-line.ts"), sent], { env, stdout: "ignore", stderr: "ignore" })
  const relay = Bun.spawn([...BUN_ISOLATED, join(root, "src/main.ts"), "serve", "claude"], { env, stdout: "pipe", stderr: "pipe" })
  for (const stream of [relay.stdout, relay.stderr]) {
    void (async () => {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        relayLog += chunk
        appendFileSync(join(dir, "relay.log"), chunk)
      }
    })()
  }
  const log = () => relayLog
  const sentLines = () => readFileSync(sent, "utf8").split("\n").filter(Boolean)
  /** ルームへの返事の本文（中継の知らせを除く） */
  const repliesSince = (n: number) =>
    sentLines()
      .slice(n)
      .map((l) => JSON.parse(l) as { kind: string; to?: string; messages?: { text?: string }[] })
      .filter((m) => (m.kind === "reply" || m.kind === "push") && (m.to === undefined || ROOM.startsWith(m.to)))
      .flatMap((m) => (m.messages ?? []).map((x) => x.text ?? "（文字なし）"))
      .filter((t) => !NOTICES.includes(t))
  let seq = 0
  const nextId = () => `${Date.now()}${String(++seq).padStart(3, "0")}`
  const webhook = async (event: Record<string, unknown>) => {
    const id = nextId()
    const body = JSON.stringify({
      destination: "Ubot",
      events: [{ webhookEventId: `ev-${id}`, timestamp: Date.now(), replyToken: `rt-${id}`, deliveryContext: { isRedelivery: false }, ...event }],
    })
    await fetch(`http://127.0.0.1:${base}/line/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Line-Signature": sign("dummysecret", body) },
      body,
    })
  }
  const say = (l: Line) =>
    webhook({
      type: "message",
      source: { type: "group", groupId: ROOM, userId: USERS[l.user] },
      message: {
        id: `m${nextId()}`,
        type: "text",
        text: l.mention ? `@bot ${l.text}` : l.text,
        ...(l.mention ? { mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] } } : {}),
      },
    })
  const turnsEnded = () => log().split("ターンの出力").length - 1
  /** ターンが終わるまで待つ。ターンの出力のログが増えるか、中継の出力と送信が quietMs のあいだ止まれば、終わったとみなす */
  const settle = async (quietMs: number) => {
    const turns = turnsEnded()
    const start = Date.now()
    let last = `${log().length}:${sentLines().length}`
    let lastChange = Date.now()
    while (Date.now() - start < 180_000) {
      await Bun.sleep(500)
      if (turnsEnded() > turns) return
      const now = `${log().length}:${sentLines().length}`
      if (now !== last) [last, lastChange] = [now, Date.now()]
      else if (Date.now() - lastChange > quietMs) return
    }
  }
  try {
    await waitFor(() => log().includes("セッションを開始しました"), 120_000, `${label}: 中継の起動`)
    await webhook({ type: "join", source: { type: "group", groupId: ROOM } })
    await waitFor(() => /relay pair [0-9a-f]{6}/.test(readFileSync(sent, "utf8")), 15_000, `${label}: ペアリングのコード`)
    const code = readFileSync(sent, "utf8").match(/relay pair ([0-9a-f]{6})/)![1]!
    Bun.spawnSync([...BUN_ISOLATED, join(root, "src/main.ts"), "pair", code], { env })
    // 受信モードを「すべて」にする（古い形の requireMention: false は、どのコミットでも「すべて」）
    const accessPath = join(home, "access.json")
    const access = JSON.parse(readFileSync(accessPath, "utf8"))
    access.rooms[`line:${ROOM}`] = { requireMention: false, allowFrom: [] }
    writeFileSync(accessPath, JSON.stringify(access))

    const run: Run = { steps: [], bursts: [] }
    for (let i = 0; i < conversation.length; ) {
      const l = conversation[i]!
      const n = sentLines().length
      if (l.burst === undefined) {
        await say(l)
        await settle(20_000)
        const replies = repliesSince(n)
        run.steps.push({ index: i, want: l.want, replies })
        console.error(`[${label}] ${i} ${l.want} ${replies.length}  ${NAMES[l.user]}：${l.text}`)
        i++
        continue
      }
      const group: number[] = []
      for (; i < conversation.length && conversation[i]!.burst === l.burst; i++) {
        await say(conversation[i]!)
        group.push(i)
        await Bun.sleep(1500)
      }
      // 差し込みと、続くターンが、すべて終わるまで待つ
      for (let quiet = false; !quiet; ) {
        const before = turnsEnded()
        await settle(25_000)
        quiet = turnsEnded() === before
      }
      const answers = group.filter((g) => conversation[g]!.want === "answer").length
      const replies = repliesSince(n)
      run.bursts.push({ indexes: group, answers, replies })
      console.error(`[${label}] burst ${group.join(",")} answers=${answers} replies=${replies.length}`)
    }
    return run
  } finally {
    relay.kill()
    mock.kill()
    await Promise.all([relay.exited, mock.exited])
    // Claude Code が作業ディレクトリごとに作る会話ログを消す（パスの英数字以外を - にした名前）
    const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")
    rmSync(join(projects, resolve(home, "workspace").replace(/[^a-zA-Z0-9]/g, "-")), { recursive: true, force: true })
  }
}

function score(run: Run): { answered: number; answers: number; spoke: number; silents: number; bursts: number; burstOk: number } {
  const answers = run.steps.filter((s) => s.want === "answer")
  const silents = run.steps.filter((s) => s.want === "silent")
  return {
    answered: answers.filter((s) => s.replies.length > 0).length,
    answers: answers.length,
    spoke: silents.filter((s) => s.replies.length > 0).length,
    silents: silents.length,
    bursts: run.bursts.length,
    burstOk: run.bursts.filter((b) => b.replies.length === b.answers).length,
  }
}

/**
 * 合格の基準。答えるべき発言の 9 割に答え、黙るべき発言に返事するのは 5% まで、束の 2/3 で返事の数が正解と同じ。
 * モデルの揺れで 1 回外れても落ちないようにする（#107 の評価では、新しい案内は両方のモデルで全問正解だった）
 */
const CHECK = { answered: 0.9, spoke: 0.05, bursts: 2 / 3 }

function failures(r: Result): string[] {
  const s = r.runs.map(score)
  const sum = (k: keyof ReturnType<typeof score>) => s.reduce((a, x) => a + x[k], 0)
  const out: string[] = []
  if (sum("answered") < CHECK.answered * sum("answers")) out.push(`${r.label}: 答えるべき発言に答えたのが ${sum("answered")}/${sum("answers")}`)
  if (sum("spoke") > CHECK.spoke * sum("silents")) out.push(`${r.label}: 黙るべき発言に返事したのが ${sum("spoke")}/${sum("silents")}`)
  if (sum("burstOk") < CHECK.bursts * sum("bursts")) out.push(`${r.label}: 束で返事の数が正解と同じだったのが ${sum("burstOk")}/${sum("bursts")}`)
  return out
}

/** 結果を Markdown の表にする。全体の数と、発言ごとに何回返事したか */
function report(results: Result[]): string {
  const set = results[0]!.set
  if (results.some((r) => r.set !== set)) throw new Error("同じ会話の結果だけを並べられます")
  const conversation = SETS[set]
  const out: string[] = [`会話：${set}`, ""]
  out.push("| ラベル | モデル | 答えるべき発言に答えた | 黙るべき発言に返事した | 束で返事の数が正解と同じ |", "|---|---|---|---|---|")
  for (const r of results) {
    const s = r.runs.map(score)
    const sum = (k: keyof ReturnType<typeof score>) => s.reduce((a, x) => a + x[k], 0)
    out.push(`| ${r.label} | ${r.model} | ${sum("answered")}/${sum("answers")} | ${sum("spoke")}/${sum("silents")} | ${sum("burstOk")}/${sum("bursts")} |`)
  }
  out.push("", `| # | 発言 | 正解 | ${results.map((r) => r.label).join(" | ")} |`, `|---|---|---|${results.map(() => "---").join("|")}|`)
  conversation.forEach((l, i) => {
    if (l.burst !== undefined) return
    const cells = results.map((r) => `${r.runs.filter((run) => run.steps.find((s) => s.index === i)!.replies.length > 0).length}/${r.runs.length}`)
    out.push(`| ${i + 1} | ${NAMES[l.user]}：${l.mention ? "（メンション）" : ""}${l.text.replace(/\|/g, "\\|")} | ${{ answer: "答える", silent: "黙る", either: "どちらでも" }[l.want]} | ${cells.join(" | ")} |`)
  })
  const bursts = [...new Set(conversation.flatMap((l) => (l.burst === undefined ? [] : [l.burst])))]
  for (const b of bursts) {
    const idx = conversation.flatMap((l, i) => (l.burst === b ? [i + 1] : []))
    const cells = results.map((r) => r.runs.map((run) => run.bursts[bursts.indexOf(b)]!.replies.length).join("・"))
    out.push(`| ${idx[0]}〜${idx.at(-1)} | （束。返事の数） | ${conversation.filter((l) => l.burst === b && l.want === "answer").length} | ${cells.join(" | ")} |`)
  }
  return out.join("\n")
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2)
  const opt = (name: string, def: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1]! : def
  }
  if (cmd === "run" && args[0] && !args[0].startsWith("--")) {
    const label = args[0]
    const set = opt("--set", "main")
    if (!(set in SETS)) throw new Error(`--set は ${Object.keys(SETS).join("・")} のどれか`)
    const root = resolve(opt("--root", join(import.meta.dir, "../..")))
    const runs = Number(opt("--runs", "3"))
    const base = Number(opt("--port", "18200"))
    const e2e = resolve(import.meta.dir, "../../.local/e2e")
    const result: Result = { label, set: set as SetName, model: process.env.ANTHROPIC_MODEL ?? "既定", root, runs: [] }
    for (let k = 0; k < runs; k++) {
      result.runs.push(await runOnce(`${label}#${k + 1}`, SETS[set as SetName], root, base, join(e2e, `addressing-${label}`, String(k + 1))))
      writeFileSync(join(e2e, `addressing-${label}.json`), JSON.stringify(result, null, 2))
    }
    console.log(report([result]))
  } else if (cmd === "report" && args.some((a) => a !== "--check")) {
    const results = args.filter((a) => a !== "--check").map((f) => JSON.parse(readFileSync(f, "utf8")) as Result)
    console.log(report(results))
    const failed = args.includes("--check") ? results.flatMap(failures) : []
    for (const f of failed) console.log(`NG: ${f}`)
    if (failed.length) process.exit(1)
  } else {
    console.error("usage: addressing.ts run <ラベル> [--set main|holdout] [--root <dir>] [--runs N] [--port N] | report [--check] <結果の JSON>...")
    process.exit(2)
  }
}
