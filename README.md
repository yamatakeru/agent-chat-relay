# agent-chat-relay

LINE・Chatwork・Discord のルームから、Claude Code などのコーディングエージェントに作業を依頼するための中継サーバーです。

ルームでの発言をエージェントのセッションに渡し、エージェントは MCP ツールを使ってルームに返信します。エージェントとは ACP（Agent Client Protocol）でやり取りするので、特定のエージェントに固有の機能には依存しません。設計の経緯は [ADR 0006](docs/adr/0006-own-core-drives-any-harness-over-acp.md) にあります。

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

- [Bun](https://bun.sh/) 1.4 以降：中継は Bun で動きます。npm でインストールする場合も必要です。
- [Claude Code](https://code.claude.com/docs/en/setup)：インストールしてログインしておいてください。中継は PATH 上の `claude` を起動します。
- git：既定の作業ディレクトリを、独立した git リポジトリにするために使います。
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)（LINE を使う場合）：Webhook を公開するために使います。

## インストール

```sh
bun install -g agent-chat-relay
```

`npm install -g agent-chat-relay` でもインストールできます（実行には Bun を使います）。コマンドは `agent-chat-relay` で、`ac-relay` という短い別名もあります。

## 使い方

Chatwork を使う場合の流れです。Bot のアカウントの準備や、LINE・Discord を使う場合の手順は [docs/relay-setup.md](docs/relay-setup.md) を参照してください。

```sh
# 1. Bot の API トークンを保存する（入力内容は表示されません）
agent-chat-relay secrets chatwork

# 2. 中継を起動する
agent-chat-relay serve
```

起動したら、Bot に DM（Chatwork ではダイレクトチャット。先に Bot とコンタクトになっておく必要があります）を送ってください。ペアリング用のコードが返ってくるので、別のターミナルで承認します。これで自分が承認者として登録されます。ルームも同じ手順で登録できます。

```sh
agent-chat-relay pair <コード>
```

エージェントは、既定では中継専用の作業ディレクトリ（`~/.agent-chat-relay/workspace/`）で作業します。普段のフォルダで作業させるには、`--workspace` で明示します。そのフォルダの中身は、登録したルームの誰の依頼からでも、実行承認なしで読まれ、ルームへ送られえます。秘密情報を置いたフォルダは指定しないでください（[docs/relay-setup.md](docs/relay-setup.md#普段の環境で動かす)）。

```sh
cd ~/work/project
agent-chat-relay serve --workspace .
```

中継のデータ（ルームの登録、許可リスト、秘密情報、作業ディレクトリ、ログ）は `~/.agent-chat-relay/` に置きます。`RELAY_HOME` で変えられます。

## 秘密情報の管理

チャットサービスのトークンなどの秘密情報は、`agent-chat-relay secrets` で `~/.agent-chat-relay/.env` に保存します。ファイルは平文で、権限を 0600（自分だけが読み書きできる）にします。

ファイルに保存せず、環境変数で渡すこともできます。環境変数は、ファイルより優先します。値をコマンドラインに直接書くとシェルの履歴に残るため、`read -rs` などで入力してください。

```sh
read -rs RELAY_CHATWORK_API_TOKEN && export RELAY_CHATWORK_API_TOKEN
agent-chat-relay serve
```

環境変数の名前は次のとおりです。

| チャットサービス | 環境変数 |
|---|---|
| LINE | `RELAY_LINE_CHANNEL_SECRET`・`RELAY_LINE_CHANNEL_TOKEN` |
| Chatwork | `RELAY_CHATWORK_API_TOKEN` |
| Discord | `RELAY_DISCORD_BOT_TOKEN` |

## 開発

リポジトリを clone し、`scripts/relay.sh` で動かします。コマンドは `agent-chat-relay` と同じです。データはリポジトリ内の `.local/relay/` に置き、秘密情報は dotenvx で暗号化してリポジトリ直下の `.env` に保存します（public リポジトリに誤ってコミットしても漏れないようにするため）。

```sh
git clone https://github.com/yamatakeru/agent-chat-relay.git
cd agent-chat-relay
mise trust
mise install
mise exec -- bun install
scripts/relay.sh secrets chatwork
scripts/relay.sh serve
```

- [mise](https://mise.jdx.dev/)：Bun と cloudflared は、`mise.toml` で固定したバージョンを mise でインストールします。Ubuntu では、git と curl も必要です（`sudo apt install git curl`）。
- [dotenvx](https://dotenvx.com/)：`scripts/relay.sh secrets` で使います。1.51 と 2.38 で動作を確認しています。インストール方法は、`brew tap dotenvx/brew && brew trust dotenvx/brew && brew install dotenvx`、`mise use -g dotenvx`、`curl -sfS https://dotenvx.sh | sh`、`npm i -g @dotenvx/dotenvx` のいずれかです。使わない場合は、`.env` を作らずに、秘密情報を環境変数で渡してください。
- テストは `mise exec -- bun test`、型検査と lint（Oxlint）は `mise exec -- bun run check`、変更した行のミューテーションテストは `mise exec -- bun run mutation` です（ADR 0021）。実際のハーネスを使う確認は [docs/relay-setup.md](docs/relay-setup.md#モックでの確認) にあります。

### clone して使っていた環境からの移行

`scripts/relay.sh` で使っていたデータは、自動では移りません。インストールした `agent-chat-relay` に移るときは、中継を止めてから、次のようにします。

```sh
mkdir -p ~/.agent-chat-relay && chmod 700 ~/.agent-chat-relay
cp <リポジトリ>/.local/relay/access.json ~/.agent-chat-relay/
agent-chat-relay secrets chatwork   # 使っているサービスの分だけ、入れ直す
```

- ルームの登録と許可リスト（`access.json`）は、そのまま使えます。
- 秘密情報は、dotenvx で暗号化した `.env` を読めないので、入れ直します。
- 作業ディレクトリの場所が変わるので、前のセッションは `--session-id` で再開できません（再開できるのは、同じ作業ディレクトリで作ったセッションだけです）。前の作業ディレクトリの中身が必要なら、`~/.agent-chat-relay/workspace/` に移してください。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/relay-setup.md](docs/relay-setup.md) | チャットサービスの準備、起動、ペアリング、動作確認の項目 |
| [docs/relay.md](docs/relay.md) | 仕様 |
| [docs/adr/](docs/adr/) | 設計判断の記録 |
| [GLOSSARY.md](GLOSSARY.md) | 用語集 |

## 経緯

当初は cc-connect の外部アダプターとして作っていました。その実装と記録は、タグ `cc-connect-final` の `old/` にあります。
