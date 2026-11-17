// 秘密情報を、画面に表示せずに入力してもらう。コマンドの引数に載せない（ps やシェルの履歴に残る）ため

/** 読んだが、まだ使っていない入力（パイプで複数行がまとめて届いたときの残り） */
let pending = ""
let ended = false

/** 1 行を読む。端末なら入力を表示しない。端末でなければ（パイプなど）、標準入力の次の行を読む */
export async function readSecret(label: string): Promise<string> {
  process.stderr.write(label)
  const stdin = process.stdin
  const tty = stdin.isTTY
  if (tty) stdin.setRawMode(true)
  stdin.setEncoding("utf8")
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = ""
      const take = (): boolean => {
        while (pending) {
          const ch = pending[0]!
          pending = pending.slice(1)
          if (ch === "\r" || ch === "\n") {
            // 改行が \r\n で届いたら、\n も読み捨てる
            if (ch === "\r" && pending[0] === "\n") pending = pending.slice(1)
            resolve(value)
            return true
          }
          if (ch === "\u0003") {
            reject(new Error("中止しました"))
            return true
          }
          if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1)
          else value += ch
        }
        if (ended) resolve(value)
        return ended
      }
      if (take()) return
      const done = () => {
        stdin.off("data", onData)
        stdin.off("end", onEnd)
      }
      const onData = (chunk: string) => {
        pending += chunk
        if (take()) done()
      }
      const onEnd = () => {
        ended = true
        take()
        done()
      }
      stdin.on("data", onData)
      stdin.on("end", onEnd)
      stdin.resume()
    })
  } finally {
    if (tty) stdin.setRawMode(false)
    stdin.pause()
    process.stderr.write("\n")
  }
}
