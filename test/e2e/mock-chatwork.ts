// e2e 用に、Chatwork の API のモック（test/fixtures/chatwork-api.ts）を 18098 番で開く。Bot の投稿を引数のファイルに JSON Lines で書く
import { appendFileSync } from "node:fs"
import { chatworkApi } from "../fixtures/chatwork-api.ts"
import { png } from "../fixtures/png.ts"

const log = process.argv[2]!
const api = chatworkApi({
  port: 18098,
  // 長い本文は、記録では先頭だけにする
  onSent: (s) => appendFileSync(log, JSON.stringify({ ...s, body: s.body.slice(0, 300) }) + "\n"),
})
// ボブが送る画像（e2e の本文の [download:55] から取る）
api.addFile("55", "photo.png", png(32, 32, [220, 20, 20]))
// 中継の起動前に届いていた依頼（記録だけされ、エージェントには渡らないはず）
api.say(7000, 1, "[To:100]AI係さん\n停止中に送った依頼：合言葉は「すずらん」", Math.floor(Date.now() / 1000) - 600)
