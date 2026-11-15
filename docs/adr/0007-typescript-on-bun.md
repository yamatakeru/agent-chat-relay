---
status: accepted
---

# 中核と接続部は TypeScript で書き、Bun で動かす

ADR 0002 で Go を選んだ理由は 3 つありました。そのうち、cc-connect 本体と突き合わせやすいことと、本体に移植しやすいことの 2 つは、ADR 0006 で cc-connect の利用をやめたことでなくなりました。残る「単一のバイナリで常駐させやすい」という理由も弱まりました。ハーネスの側で Node か Bun が必要になるからです（`claude-agent-acp` は npm パッケージ、OpenCode は Bun 製）。

新しい構成の中心になる部品は、ACP、MCP、Discord です。いずれも、TypeScript に公式または最も主流の実装があります（2026-11-09 時点）。

- ACP：公式の SDK（`@agentclientprotocol/sdk` 2.4.0）が v1 と v2 の両方に対応している。`claude-agent-acp` もこれを使っている。Go の SDK は有志によるもので、v1 にしか対応していない。
- MCP：公式のリファレンス実装がある。
- Discord：discord.js がある。手本にする公式の Discord プラグインも TypeScript で書かれている。

そこで、TypeScript で書き、Bun で動かすことにしました（2026-11-09）。

- Bun は、公式の Discord プラグインと同じ実行環境です。TypeScript をそのまま実行でき、テストランナーも備えています。`bun build --compile` で単一のバイナリにもできます。
- Bun は、mise でリポジトリ内にインストールします。

## Considered Options

- **Go のまま進める。** `old/` の LINE のコード（本体で約 1,000 行）を流用できる。ただし、ACP の v2 に対応するには、SDK の対応を待つか、自分で実装する必要がある。
- **TypeScript を Node（LTS）で動かす。** 最も実績があり、互換性の心配が少ない。ただし、手本と実行環境が揃わず、単一のバイナリにもしにくい。
- **Rust、Python。** どちらにも ACP の公式 SDK がある。Rust はこの規模の常駐プログラムには重い。Python は、型検査と配布のしやすさで劣る。

## Consequences

- ADR 0002 を置き換えます。
- `old/` の Go のコードは流用しません。仕様に関する判断（`old/docs/`）と、テストで確認した振る舞いを引き継いで書き直します。
- Go は、`old/` を動かすためだけに `mise.toml` に残しました（`old/` の削除とともに外しました）。
