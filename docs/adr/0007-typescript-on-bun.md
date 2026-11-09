---
status: accepted
---

# 中核と接続部は、TypeScript で書き、Bun で動かす

ADR 0002 で Go を選んだ理由は 3 つあった。そのうち 2 つは、ADR 0006 で cc-connect をやめたことでなくなった。cc-connect 本体と突き合わせやすいことと、本体へ移植しやすいことである。残る「単一のバイナリで常駐させやすい」も弱まった。ハーネスの側で Node か Bun が要るからである（`claude-agent-acp` は npm パッケージ、OpenCode は Bun 製）。

新しい構成で中心になる部品は、ACP、MCP、Discord である。どれも TypeScript に、公式か最も主流の実装がある（2026-11-09 時点）。

- ACP：公式の SDK（`@agentclientprotocol/sdk` 2.4.0）が v1 と v2 の両方に対応する。`claude-agent-acp` もこれを使う。Go の SDK は有志のもので、v1 にしか対応していない。
- MCP：公式の基準実装。
- Discord：discord.js。手本にする公式の Discord プラグインも TypeScript で書かれている。

そこで、TypeScript で書き、Bun で動かす（2026-11-09）。

- Bun は、公式の Discord プラグインと同じ実行環境である。TypeScript をそのまま実行でき、テストの仕組みもある。`bun build --compile` で単一のバイナリにもできる。
- Bun は、mise でリポジトリの中に入れる。

## Considered Options

- **Go のまま。** `old/` の LINE のコード（本体 約 1,000 行）を流用できる。ただ、ACP の v2 に対応するには、SDK の対応を待つか自分で書くことになる。
- **TypeScript を Node（LTS）で動かす。** 最も実績があり、互換性の心配が少ない。ただ、手本と実行環境が揃わず、単一のバイナリにもしにくい。
- **Rust、Python。** どちらにも ACP の公式 SDK がある。Rust はこの規模の常駐プログラムには重い。Python は型の検査と配布のしやすさで劣る。

## Consequences

- ADR 0002 を置き換える。
- `old/` の Go のコードは流用しない。仕様の判断（`old/docs/`）と、テストで確かめた振る舞いを引き継いで、書き直す。
- Go は、`old/` を動かすためだけに `mise.toml` に残す（`old/` の削除とともに外した）。
