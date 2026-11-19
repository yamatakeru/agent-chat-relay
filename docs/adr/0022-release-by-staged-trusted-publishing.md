---
status: accepted
---

# npm への公開は、GitHub のリリースを契機に、trusted publishing と staged publishing で行う

0.1.0 は、手元から npm に公開しました（ADR 0019）。手元から公開するには、公開できるトークンか、ログインした npm が手元に必要です。0.1.1 からは、GitHub Actions から公開することにしました。2026-11-19 に決めました。作者の別のリポジトリ（`yamatakeru/pi-claude-native`）の公開の仕組みに揃えています。

## 分かったこと

- **trusted publishing**：npm は、GitHub Actions の OIDC のトークンで公開を受け付けます。npm 11.5.1 以降が必要で、パッケージが npm にすでにあることと、`package.json` の `repository.url` がリポジトリと一致することが条件です。長く有効なトークンを、リポジトリにも手元にも置かずに済みます。
- **staged publishing**：`npm stage publish` で上げたバージョンは、管理者が 2FA を通して承認するまで、インストールできません。npm 11.15.0 以降が必要です。上げる側は 2FA を求められないので、CI から使えます。trusted publisher には、直接の公開を許さず、staged publishing だけを許すことができます。
- **Bun**：`bun publish` は、OIDC での公開に対応していません（oven-sh/bun#22423、2026-11 時点で open）。公開には npm を使います。Node 24.22.3 には npm 11.19.1 が付いています。
- 配布物の中身は、npm で詰めるか Bun で詰めるかで、違うことがあります。配布物の確かめ（`test/cli.test.ts`）は Bun で詰めているので、実際に上げる npm でも確かめる必要があります。

## 決めたこと

- GitHub のリリースを公開したら、ワークフロー（`.github/workflows/release.yml`）が、そのタグのバージョンを `npm stage publish` で上げる。公開されるのは、管理者が npm で承認したときとする。
- trusted publisher には、staged publishing だけを許す。GitHub の Environment は使わない。
- 上げる前に、CI と同じ検査（`ci.yml` を呼ぶ）、タグと `package.json` の `version` の一致、npm で詰めた配布物の中身、まだ npm にないことを確かめる。
- Node は、ワークフローの中で `mise exec node@<バージョン>` で使う。中継の実行と開発には Node を使わないので、`mise.toml` には入れない（CI の dotenvx と同じ扱い）。
- 手順は `docs/releasing.md` に書く。

## Considered Options

- **タグの push を契機にする（`pi-claude-native` の形）。** リリースノートを書かずに公開が始まる。誤って push したタグも上がるが、staged publishing の承認で止められる。0.1.0 と同じく、リリースノートとともに公開したいので、リリースを契機にした。
- **`npm publish` で直接公開する。** 承認の手間がない。ただし、ワークフローやその依存が乗っ取られると、人の目を通らずに公開される。
- **GitHub の Environment に承認者を付ける。** GitHub の画面で承認してから公開する。承認する人の確かめは GitHub のログインになり、npm の 2FA より弱い。staged publishing と重ねると、承認が 2 回になる。
- **手元から公開し続ける。** 仕組みが必要ない。ただし、公開できる資格情報が手元に必要で、どのコミットから作ったかを npm の側で確かめられない。

## Consequences

- リリースのたびに、npm で承認する手間が増えます。承認するまで、利用者はそのバージョンをインストールできません。
- staged のまま承認していないバージョンも、同じバージョンでは上げ直せません。取り消すには `npm stage reject` を使います。
- タグとリリースを作っても、ワークフローが失敗すれば npm には上がりません。リリースの公開と npm の公開は、別々に確かめます。
