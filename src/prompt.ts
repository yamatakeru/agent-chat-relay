// 秘密情報を、画面に表示せずに入力してもらう。コマンドの引数に載せない（ps やシェルの履歴に残る）ため

/**
 * 1 行を読む。bash の read -s に任せる（表示を消すことと、Ctrl+C で中断したときに端末を元に戻すことを、bash がする）。
 * 端末でなければ（パイプなど）、標準入力の次の行を読む。値はパイプで受け取り、引数には載せない
 */
export function readSecret(label: string): string {
  process.stderr.write(label)
  const r = Bun.spawnSync(["bash", "-c", 'read -rs v; echo >&2; printf %s "$v"'], { stdin: "inherit", stdout: "pipe", stderr: "inherit" })
  if (r.signalCode || r.exitCode === 130) throw new Error("中止しました")
  return r.stdout.toString().replace(/\r$/, "")
}
