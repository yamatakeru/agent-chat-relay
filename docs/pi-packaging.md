# pi の同梱物を更新・検証する

pi との接続は ACP と MCP のままです。中継は同梱の pi-acp を ACP で起動し、チャット用ツールを HTTP MCP で渡します。pi-acp は、同じ配布物の TypeScript エントリにある pi SDK の RPC を子プロセスで起動します。中継と pi-acp、pi-acp と SDK RPC のどちらにも、作業ディレクトリの `.env` と `bunfig.toml` を読ませない Bun の起動引数を付けます。端末の `pi` コマンドや追加の拡張は使いません。

`agent-chat-relay serve pi` は `<RELAY_HOME>/pi/` に pi 専用の状態を置きます。子プロセスに中継の環境変数は継承させず、専用の `HOME`・`TMPDIR`・pi の状態のパスなど、起動用に定めた変数だけを渡します。端末の設定は明示指定でだけ読み込み、自動メモリは指定を拒否します。利用者の手順は [pi のモデルと認証の準備](relay-setup.md#pi-のモデルと認証の準備)を参照してください。

モデルと認証は `<RELAY_HOME>/pi/agent/settings.json` の `defaultProvider`・`defaultModel`、同じディレクトリの `auth.json` で指定します。独自のプロバイダーには `models.json` も置きます。設定・認証ファイルは自分だけが読める通常ファイルにします（例: `0600`）。端末の認証は引き継ぎません。対話式のログインや設定コマンドは未実装です。

中継で新しく作ったセッションは、作業ディレクトリの実パスと ID を `<RELAY_HOME>/pi/registered-sessions/` に記録します。再開ではまずこの台帳を照合し、次に pi-acp の対応表とセッションファイルの実パスを確かめます。端末の対応表・セッションにはフォールバックしません。

組み込みツールは `read`・`write`・`edit`・`bash` だけを有効にします。同梱アダプターは差分表示のために対象ファイルを読み取らず、`edit`・`write` の承認前に対象を開きません。

macOS の `read` は、作業ディレクトリからシンボリックリンクをたどらずに開けた、同じファイルシステム上の通常の UTF-8 テキスト（1 MiB 以下、ハードリンクなし）なら、実行承認なしで読めます。開いたファイルから取った内容だけを pi に渡し、パスを開き直しません。外を指すパス、リンク、画像や大きなファイルなど、条件から外れるものは、承認を得てから pi 標準の読み取りを使います。起動時の確認でリンクをたどらないことを確かめられなかった場合や、Linux など macOS 以外では、すべての読み取りに実行承認を求めます。

## 固定した上流

| 同梱物 | 固定方法 | ライセンス |
| --- | --- | --- |
| pi-acp 0.0.34 | [commit `b0581c9c1d675e634234674484247008b03d69b4`](https://github.com/svkozak/pi-acp/tree/b0581c9c1d675e634234674484247008b03d69b4) のソースアーカイブを SHA-256 で照合し、そこにある npm lock を使う。`third_party/pi-acp/managed.patch` を適用する。 | `src/vendor/pi/pi-acp-LICENSE`（MIT） |
| pi SDK 1.5.2 | `@earendil-works/pi-coding-agent@1.5.2` を `package.json` と `bun.lock` で固定する。SDK のビルド済み npm パッケージを使う。 | `src/vendor/pi/pi-LICENSE`（MIT）。npm 配布物にはないため、[対応する上流コミット](https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/LICENSE) の原文を同梱する。 |

アダプターは ACP SDK 0.26.0 を `pi-acp-protocol-sdk` という npm エイリアスで使い、中継が使う ACP SDK とは分けています。通常の配布物には `src/vendor/pi/` の生成済みアダプター、アダプターのメタデータ、SDK RPC と中継管理の MCP 拡張、上記ライセンスが入ります。パッチ・ビルド用スクリプト・テストは入りません。

## アダプターを再生成する（開発者用）

ビルドには Node 24.22.3（npm 11.19.1）、`curl`、`tar`、`patch` が必要です。Node と npm はこの工程でのみ使い、利用者側のインストールや実行には使いません。

```sh
mise exec node@24.22.3 -- node scripts/build-pi-adapter.mjs
mise exec node@24.22.3 -- node scripts/build-pi-adapter.mjs --check
```

固定ソースを `.local/` に展開し、パッチを適用して `npm ci --ignore-scripts`、上流の型検査と `tsup` ビルドを順に実行します。アダプターの出力では ACP SDK の import をエイリアスに差し替え、Node 用の shebang とソースマップ参照を除きます。`--check` は、生成した JavaScript・メタデータ・ライセンスが追跡ファイルとバイト単位で一致するかを確かめるだけで、上書きしません。利用者への配布時に再ビルドはしません。

上流を更新するときは、固定バージョン・コミット・ハッシュ、パッチ、ライセンスを確認し、生成物・依存関係・`bun.lock` を更新します。実装の根拠は pi 1.5.2 の `docs/sdk.md`、`docs/rpc.md`、`docs/extensions.md` と `examples/sdk/{06-extensions,11-sessions,13-session-runtime}.ts`、MCP SDK 1.32.2 の `README.md` と Streamable HTTP クライアント例です。

## 配布物を Bun だけで確かめる

まず `bun install --frozen-lockfile`、`bun run check`、`bun --no-env-file --config=/dev/null test test/pi-bundled.test.ts test/cli.test.ts` を実行します。次に `npm pack` の実物を、開発ツリー側の依存ではなく、別のインストール先から試します。以下の例は、リポジトリ直下で、Bun 1.4.4 が PATH にある macOS から実行します。インストール後のテストは `sandbox-exec` で実行し、作業ツリーや祖先ディレクトリの開発用 `node_modules` を読めなくします。

```sh
root=$PWD
mkdir -p "$root/.local"
work=$(mktemp -d "$root/.local/pi-package.XXXXXX")
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/pkg" "$work/consumer" "$work/home" "$work/tmp"
bun_dir=$(dirname "$(command -v bun)")
profile="$work/isolated.sb"
{
  printf '(version 1)\n(allow default)\n'
  parent=$(cd "$work" && pwd -P)
  while :; do
    escaped=$(printf '%s' "${parent%/}/node_modules" | perl -pe 's/(["\\])/\\$1/g')
    printf '(deny file-read* (subpath "%s"))\n' "$escaped"
    [ "$parent" != / ] || break
    parent=$(dirname "$parent")
  done
} > "$profile"
mise exec node@24.22.3 -- npm pack --ignore-scripts --pack-destination "$work/pkg"
tar -tzf "$work"/pkg/*.tgz
(
  cd "$work/consumer"
  printf '%s\n' '{"name":"pi-package-check","private":true}' > package.json
  env -i PATH="$bun_dir:/usr/bin:/bin" HOME="$work/home" TMPDIR="$work/tmp" \
    BUN_INSTALL_CACHE_DIR="$root/.local/bun/cache" sh -eu -c '
      ! command -v node && ! command -v npm && ! command -v pi || exit 1
      bun --no-env-file --config=/dev/null add --ignore-scripts "$1"
      RELAY_TEST_PI_PACKAGE="$PWD/node_modules/agent-chat-relay" \
        sandbox-exec -f "$3" bun --no-env-file --config=/dev/null test "$2"
    ' sh "$work"/pkg/*.tgz "$root/test/pi-bundled.test.ts" "$profile"
)
```

テストは偽モデルと偽チャットコネクターを使い、ACP で新規・再開し、実際の pi から HTTP MCP の `reply` を通します。新規・再開の両方で、作業ディレクトリ外の読み取り・書き込み・編集・シェルへの実行承認を拒否し、同じ操作を今回だけ許可します。macOS では作業ディレクトリ内の通常のテキストを承認なしで読めること、作業ディレクトリ外を指すリンクは承認なしで読めないことも確かめます。承認待ちで切断した後の許可が効かないことや、他のセッションの再開と古い MCP トークンでの準備完了を拒むことも確かめます。インストールした `bin/agent-chat-relay` からの再開も確認します。実サービスへの接続やログインは行いません。配布物をインストールすると推移依存は再解決されるため、リポジトリでの `bun.lock` 固定検証とは別です。
