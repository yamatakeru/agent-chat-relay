// 中継のバージョン。package.json から読む（npm の配布物にも、package.json は必ず入る）
import pkg from "../package.json" with { type: "json" }

export const VERSION: string = pkg.version
