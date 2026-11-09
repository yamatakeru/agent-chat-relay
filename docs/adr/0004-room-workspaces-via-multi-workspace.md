---
status: superseded by ADR 0006
---

# ルームごとの作業場所は、multi-workspace モードと、アダプターが書く割り当てファイルで分ける

> ADR 0006 で cc-connect をやめ、自作の中核が ACP でハーネスを動かす形に置き換えた。

段階 1 で、ルームの間で作業場所のファイルが共有され、情報が漏れることが分かった。そこで、ルームごとに作業場所を丸ごと分け、ルームの登録は再起動なしでできるようにする。

このために、cc-connect の multi-workspace モードを使う。ルームと作業場所の割り当ては、アダプター（登録用のスクリプトを含む）が `<data_dir>/workspace_bindings.json` に直接書く。

- cloud_web はチャンネル名を返さないので、cc-connect が規約に従って自動で割り当てることはない。
- `/workspace` コマンドは、承認の迂回や任意の clone につながるので、無効のままにする。
- cc-connect は、参照のたびにファイルの更新時刻と大きさを見て読み直す（`core/workspace_binding.go` の `refreshLocked`）。そのため、書き足した割り当ては再起動なしで効く。

2026-11-07 に、cloud_web と Claude Code を使ってローカルで次を確かめた。

- 起動中に書き足した割り当てが、再起動なしで効いた。
- ルームごとに作業ディレクトリが分かれた。ファイル、会話、Claude の会話ログ（`~/.claude/projects/`）のどれも分かれた。
- 承認は、ルームごとに通った。
- 再起動後も、ルームごとに会話が続いた。

## Considered Options

- ルームごとに cc-connect の project を分ける。確実だが、ルームを足すたびに設定の書き換えと再起動が要る。
- `/workspace bind` をアダプターから送る。そのためには `/workspace` を有効にする必要があり、ルームから打たれる経路を別に塞がなければならない。

## Consequences

- cc-connect の内部ファイルの形式に依存する。形式は `{"project:<名前>": {"<platform 名>:<ルームの ID>": {"channel_name", "workspace", "bound_at"}}}`。cc-connect の版を上げるときは、形式が変わっていないか確かめる。書くときは、一時ファイルを書いてから rename する。
- 割り当てのないルームの発言を cc-connect に渡してはならない。cc-connect は、割り当てのないルームで git の URL を送るよう案内し、送られた URL を clone する。この流れは `/workspace` を無効にしていても動く（`handleWorkspaceInitFlow`）。アダプターは、割り当てを書いてから発言を渡す。1 対 1 トークは登録を要しないので、最初の発言のときに割り当てを書く。
- multi-workspace モードでは、agent の `work_dir` は使えない。代わりに `base_dir` を使う。
