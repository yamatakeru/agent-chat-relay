# agent-chat-relay

業務チャット（LINE・LINE WORKS・Chatwork・Discord）と、コーディングエージェントの間を中継する薄い層。自作の中核が ACP（Agent Client Protocol）でハーネス（Claude Code、OpenCode など）を動かし、MCP のツールでルームの読み書きを渡す。判断の経緯は `docs/adr/` にある（ADR 0006）。

当初は cc-connect の外部アダプターとして作っていた。その実装と記録は、タグ `cc-connect-final` の `old/` で読める。

## 動かす環境

- macOS（Apple Silicon）と Ubuntu 24.04（x86_64）。
- Ubuntu では、CI（`.github/workflows/ci.yml`）で、依存の導入・型検査・単体テストを確かめている。実際のハーネスとチャットサービスでの確認は、まだ macOS でだけしている。

## 必要なもの

| もの | 入れ方 |
|---|---|
| git・curl | Ubuntu では `sudo apt install git curl`。macOS には入っている |
| [mise](https://mise.jdx.dev/) | `curl https://mise.run \| sh`、または `brew install mise`。Bun と cloudflared の版は `mise.toml` で固定していて、`mise install` で入る |
| Claude Code（`claude`） | 公式の手順で入れて、ログインしておく。中継は、PATH にある `claude` を動かす |
| dotenvx（任意） | 下を参照 |

そのうえで、リポジトリの中で `mise install` と `mise exec -- bun install` を実行する。`node_modules` には Agent SDK に同梱の Claude CLI（約 300MB）も入るが、使わない。

## dotenvx（任意）

秘密情報（チャットサービスのトークンなど）を、暗号化してリポジトリ直下の `.env` に置くために使う。`scripts/relay.sh secrets` が暗号化して保存し、`scripts/relay.sh serve` が復号して中継に渡す。中継そのものには要らない。

入れ方はどれでもよい。PATH にある `dotenvx` を使う。1.51 と 2.38 で確かめている。

| 方法 | コマンド |
|---|---|
| Homebrew | `brew tap dotenvx/brew && brew trust dotenvx/brew && brew install dotenvx` |
| mise | `mise use -g dotenvx`（このリポジトリの `mise.toml` には入れていない） |
| curl | `curl -sfS https://dotenvx.sh \| sh` |
| npm | `npm i -g @dotenvx/dotenvx` |

使わないときは、`.env` を作らずに、秘密情報を環境変数で渡して起動する。`.env` が無ければ、`scripts/relay.sh` は dotenvx を呼ばない。値をコマンドに直接書くと、シェルの履歴に残るので、たとえば `read -rs` で入れる。

```sh
read -rs RELAY_CHATWORK_API_TOKEN && export RELAY_CHATWORK_API_TOKEN
scripts/relay.sh serve
```

環境変数の名前は、`docs/relay-setup.md` の「用意」にある。

## 使い方

チャットサービスの準備、起動、ペアリング、確かめる項目は `docs/relay-setup.md` に、仕様は `docs/relay.md` にある。
