// 接続部が持つ、上限つきの覚え書き（重複の除去、ID の対応など）。プロセスのメモリにだけ置く。

const CACHE_CAP = 1000

/** 入れて、上限を超えたら最も古いものを捨てる */
export function remember(c: Set<string>, key: string): void
export function remember<V>(c: Map<string, V>, key: string, value: V): void
export function remember<V>(c: Set<string> | Map<string, V>, key: string, value?: V): void {
  if (c instanceof Set) c.add(key)
  else c.set(key, value!)
  if (c.size > CACHE_CAP) c.delete(c.keys().next().value!)
}
