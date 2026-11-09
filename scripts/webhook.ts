// 開発用：署名付きの LINE の Webhook を、ローカルの中継へ送る。秘密は環境変数から読む。
//
//   text <room> <user> <本文> [--mention]   room が U… なら 1 対 1 のトーク
//   image <room> <user>                     画像の発言（本体は LINE の API のモックが返す）
//   file <room> <user> <ファイル名>
//   join <room>                             Bot がグループに追加された
//   postback <user> <data>                  ボタン（承認など）の操作

import { createHmac } from "node:crypto"

const [kind, ...args] = process.argv.slice(2)
const secret = process.env.RELAY_LINE_CHANNEL_SECRET
if (!secret) throw new Error("RELAY_LINE_CHANNEL_SECRET がありません")
const port = process.env.RELAY_LINE_PORT ?? "18080"

function source(room: string, user?: string) {
  if (room.startsWith("U")) return { type: "user", userId: room }
  return room.startsWith("R") ? { type: "room", roomId: room, userId: user } : { type: "group", groupId: room, userId: user }
}

const id = String(Date.now()) + String(Math.floor(Math.random() * 1000)).padStart(3, "0")
const base = { webhookEventId: `ev-${id}`, timestamp: Date.now(), replyToken: `rt-${id}`, deliveryContext: { isRedelivery: false } }
let event: Record<string, unknown>
switch (kind) {
  case "text": {
    const [room, user, text = "", flag] = args
    const mention = flag === "--mention" ? { mention: { mentionees: [{ index: 0, length: 4, type: "user", isSelf: true }] } } : {}
    event = { ...base, type: "message", source: source(room!, user), message: { id, type: "text", text: flag === "--mention" ? `@bot ${text}` : text, quoteToken: `q-${id}`, ...mention } }
    break
  }
  case "image":
    event = { ...base, type: "message", source: source(args[0]!, args[1]), message: { id, type: "image", contentProvider: { type: "line" } } }
    break
  case "file":
    event = { ...base, type: "message", source: source(args[0]!, args[1]), message: { id, type: "file", fileName: args[2], fileSize: 100 } }
    break
  case "join":
    event = { ...base, type: "join", source: source(args[0]!) }
    break
  case "postback":
    event = { ...base, type: "postback", source: source(args[0]!), postback: { data: args[1] } }
    break
  default:
    throw new Error("usage: webhook text|image|file|join|postback ...")
}
const body = JSON.stringify({ destination: "Ubot", events: [event] })
const signature = createHmac("sha256", secret).update(body).digest("base64")
const res = await fetch(`http://127.0.0.1:${port}/line/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Line-Signature": signature }, body })
console.log(`webhook ${kind}: HTTP ${res.status} (message id ${id})`)
