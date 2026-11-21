// Jev（TypeSafe AI の System One モデル）で判定する。
// - 承認依頼の依頼者を推す（ADR 0026）。送り手が複数いるターンでだけ使う。推せなければ undefined を返し、中核は全員に送る。
// - 受信モードが「他人宛てを除く（Jev）」のルームで、メンションも他人宛ての印もない発言が、他人宛てかを判定する（ADR 0029）。
//   判定できなければ undefined を返し、中核は渡す。

import { z } from "zod"
import type { AttributionQuery, Attributor, Log, ScreenQuery, Screener } from "./core/relay.ts"

const ENDPOINT = "https://api.typesafe.ai/v1/systemone"
/** 別名（jev-latest）は指す先が変わり、下限を合わせた確率の意味が変わるので、バージョンを固定する */
const MODEL = "jev-1.14.0"
const TIMEOUT_MS = 2000
const DEFAULT_MIN_PROBABILITY = 0.8
/** Jev に渡す長さ。題名・入力・エージェントの文・発言の本文・名前（表示名とルーム名）と、発言の数 */
const LIMITS = { title: 500, input: 2000, agentText: 2000, text: 1000, name: 100, messages: 30 }
/** 「どの人でもない」の選択肢。人の選択肢は p1, p2, … なので重ならない */
const NONE = "none"

/** Jev に問い合わせ、答えを schema で確かめて返す。失敗したら、ログに書いて undefined を返す */
async function ask<T>(key: string, body: unknown, schema: z.ZodType<T>, log: Log, fetchFn: typeof fetch): Promise<T | undefined> {
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
  const parsed = schema.safeParse(await res.json().catch(() => undefined))
  if (!parsed.success) {
    log.error("Jev の答えの形が想定外です")
    return undefined
  }
  return parsed.data
}

/** API キー（RELAY_TYPESAFE_API_KEY）があれば、Jev で推す関数を返す。下限の指定が不正なら、起動しない */
export function jevFromEnv(env: Record<string, string | undefined>, log: Log, fetchFn: typeof fetch = fetch): Attributor | undefined {
  const key = env.RELAY_TYPESAFE_API_KEY
  if (!key) return undefined
  const min = minProbability(env.RELAY_JEV_MIN_PROBABILITY)
  return async (q) => {
    const { body, people } = request(q)
    const answer = await ask(key, body, RESPONSE, log, fetchFn)
    if (!answer) return undefined
    const { choice, probabilities } = answer.answers.requester
    const probability = probabilities[choice]!
    const sender = people.get(choice)
    log.info("Jev で承認依頼の依頼者を推しました", { sender, probability, min })
    if (!sender || probability < min) return undefined
    return { sender, probability }
  }
}

/** Jev の答え。選んだ選択肢の確率があるものだけを受け付ける */
const RESPONSE = z.object({
  answers: z.object({
    requester: z.object({ choice: z.string(), probabilities: z.record(z.string(), z.number()) }).refine((a) => a.choice in a.probabilities),
  }),
})

/** 下限。0 より大きく 1 以下の数。空なら既定 */
function minProbability(v: string | undefined): number {
  if (!v) return DEFAULT_MIN_PROBABILITY
  const n = Number(v)
  if (!(n > 0 && n <= 1)) throw new Error(`RELAY_JEV_MIN_PROBABILITY に指定できるのは、0 より大きく 1 以下の数です（今は ${JSON.stringify(v)}）`)
  return n
}

/** Jev への要求。人には p1, p2, … の名前を付け、ID は送らない。people は、その名前から ID へ */
function request(q: AttributionQuery): { body: unknown; people: Map<string, string> } {
  const people = new Map<string, string>()
  const labels = new Map<string, string>()
  const criteria: Record<string, string> = {}
  const messages = q.messages.slice(-LIMITS.messages).map((m) => {
    const name = m.name.slice(0, LIMITS.name)
    let label = labels.get(m.sender)
    if (!label) {
      label = `p${labels.size + 1}`
      labels.set(m.sender, label)
      people.set(label, m.sender)
      criteria[label] = name ? `The person ${label} (shown as "${name}")` : `The person ${label} (no display name)`
    }
    return { person: label, name, room: m.room.slice(0, LIMITS.name), mentioned: m.mentioned, text: m.text.slice(0, LIMITS.text) }
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

// ---- 他人宛ての判定（ADR 0029） ----

/**
 * 他人宛ての判定の問い。1 つの問いに 1 つの条件を書き、組み合わせはコードで決める（DROP）。
 * 問いを変えたら、scripts/jev-eval.sh で、実際の Jev に評価の会話を流し直す（bun run pre-pr が挙げる。docs/addressing-eval.md）
 */
export const SCREEN_QUESTIONS = {
  agent: {
    type: "noul",
    instructions: "Is `message.text` addressed to `agent`, the AI assistant in this group chat?",
  },
  other: {
    type: "noul",
    instructions: "Is `message.text` addressed to one or more specific people in the chat other than `agent`?",
    criteria: {
      true: "It speaks to particular people other than the agent, by name or by replying to what they said",
      false: "It speaks to the agent, to everyone, to whoever can answer, or to no one in particular",
    },
  },
  answers_agent: {
    type: "noul",
    instructions: "Does `message.text` answer a question or a request that `agent` made in `recent_messages`?",
  },
} as const

/**
 * 外す条件。ほかの人宛てである確率が高く、agent 宛てである確率と、agent への答えである確率がどちらも低いときだけ外す。
 * 外し過ぎると、エージェントが答えるべき発言を落とすので、迷う発言は渡す
 */
const DROP = { other: 0.8, agent: 0.2, answersAgent: 0.2 }
/** state に入れる直前の発言の数（RELAY_JEV_CONTEXT_MESSAGES） */
const CONTEXT = { default: 10, max: 30 }

const SCREEN_RESPONSE = z.object({
  answers: z.object({
    agent: z.object({ noul: z.number() }),
    other: z.object({ noul: z.number() }),
    answers_agent: z.object({ noul: z.number() }),
  }),
})

/** API キーがあれば、他人宛てを判定する関数を返す。直前の発言の数の指定が不正なら、起動しない */
export function screenFromEnv(env: Record<string, string | undefined>, log: Log, fetchFn: typeof fetch = fetch): Screener | undefined {
  const key = env.RELAY_TYPESAFE_API_KEY
  if (!key) return undefined
  const context = contextMessages(env.RELAY_JEV_CONTEXT_MESSAGES)
  return async (q) => {
    const answer = await ask(key, screenRequest(q, context), SCREEN_RESPONSE, log, fetchFn)
    if (!answer) return undefined
    const a = answer.answers
    const probabilities = { agent: a.agent.noul, other: a.other.noul, answersAgent: a.answers_agent.noul }
    const drop = probabilities.other >= DROP.other && probabilities.agent <= DROP.agent && probabilities.answersAgent <= DROP.answersAgent
    return { drop, probabilities }
  }
}

/** 直前の発言の数。0〜30 の整数。空なら既定 */
function contextMessages(v: string | undefined): number {
  if (!v) return CONTEXT.default
  const n = Number(v)
  if (!/^\d+$/.test(v) || n > CONTEXT.max) throw new Error(`RELAY_JEV_CONTEXT_MESSAGES に指定できるのは 0〜${CONTEXT.max} の整数です（今は ${JSON.stringify(v)}）`)
  return n
}

/** 他人宛ての判定の要求。人には p1, p2, … の名前を付け、ID は送らない。Bot の発言は agent にする */
export function screenRequest(q: ScreenQuery, context: number): unknown {
  const labels = new Map<string, string>()
  const person = (m: ScreenQuery["message"]) => {
    if (m.fromMe) return { person: "agent" }
    let label = labels.get(m.sender)
    if (!label) labels.set(m.sender, (label = `p${labels.size + 1}`))
    return { person: label, name: m.name.slice(0, LIMITS.name) }
  }
  // slice(-0) はすべてを返すので、0 は別に扱う
  const recent = context === 0 ? [] : q.recent.slice(-context)
  return {
    model: MODEL,
    state: {
      chat: { service: q.service, room: q.room.slice(0, LIMITS.name) },
      agent: "An AI assistant that is a member of this group chat. Its own messages appear as the person `agent`.",
      recent_messages: recent.map((m) => ({ ...person(m), text: m.text.slice(0, LIMITS.text) })),
      message: { ...person(q.message), text: q.message.text.slice(0, LIMITS.text) },
    },
    questions: SCREEN_QUESTIONS,
  }
}
