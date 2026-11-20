// 承認依頼の依頼者を、Jev（TypeSafe AI の System One モデル）で推す（ADR 0026）。
// 送り手が複数いるターンでだけ使う。推せなければ undefined を返し、中核は全員に送る。

import type { AttributionQuery, Attributor, Log } from "./core/relay.ts"

const ENDPOINT = "https://api.typesafe.ai/v1/systemone"
/** 別名（jev-latest）は指す先が変わり、下限を合わせた確率の意味が変わるので、バージョンを固定する */
const MODEL = "jev-1.14.0"
const TIMEOUT_MS = 2000
const DEFAULT_MIN_PROBABILITY = 0.8
/** Jev に渡す長さ。題名・入力・エージェントの文・発言の本文と、発言の数 */
const LIMITS = { title: 500, input: 2000, agentText: 2000, text: 1000, messages: 30 }
/** 「どの人でもない」の選択肢。人の選択肢は p1, p2, … なので重ならない */
const NONE = "none"

/** API キー（RELAY_TYPESAFE_API_KEY）があれば、Jev で推す関数を返す。下限の指定が不正なら、起動しない */
export function jevFromEnv(env: Record<string, string | undefined>, log: Log, fetchFn: typeof fetch = fetch): Attributor | undefined {
  const key = env.RELAY_TYPESAFE_API_KEY
  if (!key) return undefined
  const min = minProbability(env.RELAY_JEV_MIN_PROBABILITY)
  return async (q) => {
    const { body, people } = request(q)
    let res: Response
    try {
      res = await fetchFn(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      log.error("Jev に問い合わせられませんでした", { error: String(err) })
      return undefined
    }
    if (!res.ok) {
      log.error("Jev がエラーを返しました", { status: res.status })
      return undefined
    }
    const answer = ((await res.json().catch(() => undefined)) as JevResponse | undefined)?.answers?.requester
    const choice = answer?.choice
    const probability = typeof choice === "string" ? answer?.probabilities?.[choice] : undefined
    if (typeof choice !== "string" || typeof probability !== "number") {
      log.error("Jev の答えの形が想定外です")
      return undefined
    }
    const sender = people.get(choice)
    log.info("Jev で承認依頼の依頼者を推しました", { sender: sender ?? choice, probability, min })
    if (!sender || probability < min) return undefined
    return { sender, probability }
  }
}

type JevResponse = { answers?: { requester?: { choice?: unknown; probabilities?: Record<string, unknown> } } }

/** 下限。0 より大きく 1 以下の小数。空なら既定 */
function minProbability(v: string | undefined): number {
  if (!v) return DEFAULT_MIN_PROBABILITY
  const n = Number(v)
  if (!/^\d+(\.\d+)?$/.test(v) || !(n > 0 && n <= 1)) throw new Error(`RELAY_JEV_MIN_PROBABILITY に指定できるのは、0 より大きく 1 以下の数です（今は ${JSON.stringify(v)}）`)
  return n
}

/** Jev への要求。人には p1, p2, … の名前を付け、ID は送らない。people は、その名前から ID へ */
function request(q: AttributionQuery): { body: unknown; people: Map<string, string> } {
  const people = new Map<string, string>()
  const labels = new Map<string, string>()
  const criteria: Record<string, string> = {}
  const messages = q.messages.slice(-LIMITS.messages).map((m) => {
    let label = labels.get(m.sender)
    if (!label) {
      label = `p${labels.size + 1}`
      labels.set(m.sender, label)
      people.set(label, m.sender)
      criteria[label] = `The person ${label} (shown as "${m.name}")`
    }
    return { person: label, name: m.name, room: m.room, mentioned: m.mentioned, text: m.text.slice(0, LIMITS.text) }
  })
  criteria[NONE] = "None of these people, or it cannot be told from the state"
  return {
    people,
    body: {
      model: MODEL,
      state: {
        permission_request: { tool: q.title.slice(0, LIMITS.title), input: q.input.slice(0, LIMITS.input) },
        agent_text: q.agentText.slice(-LIMITS.agentText),
        chat_messages: messages,
      },
      questions: {
        requester: {
          type: "choice",
          instructions:
            "An AI agent in a group chat asks for permission to run the tool in `permission_request`. `chat_messages` are the messages it received in this turn, and `agent_text` is what it wrote. Whose request is the agent carrying out with this tool?",
          criteria,
        },
      },
    },
  }
}
