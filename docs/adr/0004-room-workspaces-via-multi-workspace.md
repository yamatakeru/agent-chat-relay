---
status: superseded by ADR 0006
---

# ルームごとの作業場所は、multi-workspace モードと、アダプターが書く割り当てファイルで分ける

> ADR 0006 で cc-connect の利用をやめ、自作の中核が ACP でハーネスを動かす構成に置き換えました。

段階 1 で、ルーム間で作業場所のファイルが共有され、情報が漏れることが分かりました。そこで、ルームごとに作業場所を丸ごと分け、ルームの登録を再起動なしでできるようにします。

そのために、cc-connect の multi-workspace モードを使います。ルームと作業場所の割り当ては、アダプター（登録用のスクリプトを含む）が `<data_dir>/workspace_bindings.json` に直接書き込みます。

- cloud_web はチャンネル名を返さないので、cc-connect が命名規則に従って自動で割り当てることはありません。
- `/workspace` コマンドは、承認の迂回や任意のリポジトリの clone につながるので、無効のままにします。
- cc-connect は、参照するたびにファイルの更新時刻とサイズを確認して読み直します（`core/workspace_binding.go` の `refreshLocked`）。そのため、追記した割り当ては再起動なしで反映されます。

2026-11-07 に、cloud_web と Claude Code を使って、ローカルで次のことを確認しました。

- 起動中に追記した割り当てが、再起動なしで反映された。
- ルームごとに作業ディレクトリが分かれた。ファイル、会話、Claude の会話ログ（`~/.claude/projects/`）のいずれも分かれた。
- 承認は、ルームごとに機能した。
- 再起動後も、ルームごとに会話が続いた。

## Considered Options

- ルームごとに cc-connect の project を分ける。確実だが、ルームを追加するたびに設定の書き換えと再起動が必要になる。
- `/workspace bind` をアダプターから送る。そのためには `/workspace` を有効にする必要があり、ルームから入力される経路を別途塞がなければならない。

## Consequences

- cc-connect の内部ファイルの形式に依存します。形式は `{"project:<名前>": {"<platform 名>:<ルームの ID>": {"channel_name", "workspace", "bound_at"}}}` です。cc-connect のバージョンを上げるときは、形式が変わっていないかを確認します。書き込むときは、一時ファイルに書いてから rename します。
- 割り当てのないルームの発言を cc-connect に渡してはいけません。cc-connect は、割り当てのないルームでは git の URL を送るよう案内し、送られた URL を clone します。この動作は `/workspace` を無効にしていても働きます（`handleWorkspaceInitFlow`）。アダプターは、割り当てを書き込んでから発言を渡します。1 対 1 のトークは登録が不要なので、最初の発言のときに割り当てを書き込みます。
- multi-workspace モードでは、agent の `work_dir` は使えません。代わりに `base_dir` を使います。
