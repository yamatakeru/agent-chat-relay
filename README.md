# agent-chat-relay

LINE・Chatwork・Discord のルームから、Claude Code などのコーディングエージェントに作業を依頼するための中継サーバーです。

ルームでの発言をエージェントのセッションに渡し、エージェントは MCP ツールを使ってルームに返信します。エージェント（このリポジトリでは「ハーネス」と呼びます）とは ACP（Agent Client Protocol）でやり取りするので、特定のエージェントに固有の機能には依存しません。設計の経緯は [ADR 0006](docs/adr/0006-own-core-drives-any-harness-over-acp.md) にあります。

## 主な機能

- 登録したルームで Bot 宛ての発言があると、エージェントに渡して、返事をルームに投稿します。
- エージェントは、ほかのルームへの投稿、過去の発言の参照、添付ファイルの受け取りと送信ができます。
- エージェントがファイルの書き込みやコマンドの実行をするときは、承認者の DM に承認を依頼します。
- ルームと承認者は、ペアリング用のコードで登録します。

## 対応状況

| 種類 | 対象 | 状況 |
|---|---|---|
| チャットサービス | LINE | 対応済み（実環境で確認済み） |
| | Chatwork・Discord | 対応済み（モックで確認済み。実環境では未確認） |
| | LINE WORKS | 未対応 |
| ハーネス | Claude Code | 対応済み |
| | OpenCode | 試験的。実行承認が働かないため、既定では起動しません（[#6](https://github.com/yamatakeru/agent-chat-relay/issues/6)） |
| OS | macOS（Apple Silicon） | 動作確認済み |
| | Ubuntu 24.04（x86_64） | CI でテストが通ることのみ確認済み |

## 前提条件

- git・curl（Ubuntu では `sudo apt install git curl`）
- [mise](https://mise.jdx.dev/)：Bun と cloudflared は、`mise.toml` で固定したバージョンを mise でインストールします。
- [Claude Code](https://code.claude.com/docs/en/setup)：インストールしてログインしておいてください。中継は PATH 上の `claude` を起動します。
- [dotenvx](https://dotenvx.com/)（任意）：秘密情報を暗号化して保存する場合に使います。詳しくは「[秘密情報の管理](#秘密情報の管理)」を参照してください。

## セットアップ

```sh
git clone https://github.com/yamatakeru/agent-chat-relay.git
cd agent-chat-relay
mise trust
mise install
mise exec -- bun install
```

## 使い方

Chatwork を使う場合の流れです。Bot のアカウントの準備や、LINE・Discord を使う場合の手順は [docs/relay-setup.md](docs/relay-setup.md) を参照してください。

```sh
# 1. Bot の API トークンを保存する（入力内容は表示されません）
scripts/relay.sh secrets chatwork

# 2. 中継を起動する
scripts/relay.sh serve
```

起動したら、Bot に DM（Chatwork ではダイレクトチャット。先に Bot とコンタクトになっておく必要があります）を送ってください。ペアリング用のコードが返ってくるので、別のターミナルで承認します。これで自分が承認者として登録されます。ルームも同じ手順で登録できます。

```sh
scripts/relay.sh pair <コード>
```

## 秘密情報の管理

チャットサービスのトークンなどの秘密情報は、dotenvx で暗号化して、リポジトリ直下の `.env` に保存します。`scripts/relay.sh secrets` が暗号化して保存し、`scripts/relay.sh serve` が復号して中継に渡します。

dotenvx は次のいずれかの方法でインストールしてください。1.51 と 2.38 で動作を確認しています。

```sh
# Homebrew
brew tap dotenvx/brew && brew trust dotenvx/brew && brew install dotenvx

# mise
mise use -g dotenvx

# curl
curl -sfS https://dotenvx.sh | sh

# npm
npm i -g @dotenvx/dotenvx
```

dotenvx を使わない場合は、`.env` を作らずに、秘密情報を環境変数で渡して起動してください。`.env` がなければ、dotenvx は呼び出されません。値をコマンドラインに直接書くとシェルの履歴に残るため、`read -rs` などで入力してください。

```sh
read -rs RELAY_CHATWORK_API_TOKEN && export RELAY_CHATWORK_API_TOKEN
scripts/relay.sh serve
```

環境変数の名前は次のとおりです。

| チャットサービス | 環境変数 |
|---|---|
| LINE | `RELAY_LINE_CHANNEL_SECRET`・`RELAY_LINE_CHANNEL_TOKEN` |
| Chatwork | `RELAY_CHATWORK_API_TOKEN` |
| Discord | `RELAY_DISCORD_BOT_TOKEN` |

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/relay-setup.md](docs/relay-setup.md) | チャットサービスの準備、起動、ペアリング、動作確認の項目 |
| [docs/relay.md](docs/relay.md) | 仕様 |
| [docs/adr/](docs/adr/) | 設計判断の記録 |
| [GLOSSARY.md](GLOSSARY.md) | 用語集 |

## 経緯

当初は cc-connect の外部アダプターとして作っていました。その実装と記録は、タグ `cc-connect-final` の `old/` にあります。
