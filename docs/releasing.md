# リリースの手順

npm のパッケージ `agent-chat-relay` の新しいバージョンを公開する手順です。0.1.1 以降は、GitHub Actions から、trusted publishing（OIDC）と staged publishing で上げます（ADR 0022）。0.1.0 は、手元から公開しました。

## 流れ

1. **e2e の中核を走らせる**：`test/e2e/line.sh claude` と `test/e2e/resume.sh claude` が、0 で終わることを確かめます（ADR 0023）。Claude Code は固定していないので、中継を変えていなくても、ハーネスとの結合が壊れていることがあります。モデルは Haiku で足ります（`ANTHROPIC_MODEL=haiku`）。Claude Code の会話ログは、終わるときにスクリプトが削除します。
2. **バージョンを上げる PR を出す**：`package.json` の `version` を上げます。`bun.lock` にはパッケージ自身のバージョンがないので、変えません。マージは、ほかの PR と同じく merge commit で行います。
3. **タグを打ち、リリースを公開する**：マージでできた `main` のコミットにタグを打ち、push してから、そのタグでリリースを公開します。リリースノートは、0.1.0 と同じく、前のバージョンからの変更を利用者に向けて書きます。

   ```sh
   git tag v<x.y.z> <マージのコミット> && git push origin v<x.y.z> &&
     gh release create v<x.y.z> --verify-tag --title v<x.y.z> --notes-file <リリースノート>
   ```

   `git push` は、リモートに同じタグがあれば失敗します。`--verify-tag` は、push したタグがなければリリースを作りません。そのため、別のコミットでリリースが公開されることはありません。
4. **ワークフローが npm に上げる**：リリースを公開すると、`.github/workflows/release.yml` が動きます。CI と同じ検査（`ci.yml`）を通したあと、次を確かめてから、`npm stage publish` で上げます。
   - タグが、`package.json` の `version` と一致すること。
   - npm で詰めた配布物に、入り口と本体（`bin/`・`src/`）と `package.json`・`LICENSE`・`README.md` のほかが入っていないこと（ADR 0019）。
   - そのバージョンが、まだ npm にないこと。あれば、上げずに終わります。
5. **npm で承認する**：上げただけでは、インストールできません。npmjs.com の Staged Packages で、2FA を通して承認します。CLI では `npm stage list agent-chat-relay` で ID を調べ、`npm stage approve <ID>` で承認します。承認する前に、`npm stage download <ID>` で中身を確かめられます。

## trusted publisher の設定

npm のパッケージの設定（Settings の Trusted publishing）で、GitHub Actions を、次の値で登録します。

| 項目 | 値 |
|---|---|
| ユーザー | `yamatakeru` |
| リポジトリ | `agent-chat-relay` |
| ワークフロー | `release.yml` |
| Environment | なし |
| 許可する操作 | staged publishing だけ（直接の公開は許可しない） |

CLI では、npm 11.15.0 以降で次のようにします（2FA が必要）。

```sh
npm trust github agent-chat-relay --repo yamatakeru/agent-chat-relay --file release.yml --allow-stage-publish
```

登録してから 48 時間のうちに一度も上げないと、その登録は期限が切れ、使えなくなります（[GitHub Changelog、2026-10-02](https://github.blog/changelog/2026-10-02-unvalidated-npm-trusted-publishing-configurations-now-expire/)）。一度上げれば、期限はなくなります。初めて使うときは、リリースの直前に登録します。
