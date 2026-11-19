---
status: accepted
---

# 一般の lint は Oxlint で行い、型の情報を使う検査も `bun run check` で動かす

検査は、`tsc --noEmit` と、このリポジトリで繰り返したミスから作った `scripts/check.ts` だけで、一般の lint がありませんでした。`check.ts` は、まだ起きていないミスを防ぐ一般の検査を持ちません。言語・エコシステムの標準の検査は、ミスが出るのを待たずに揃えることにしました（#53）。2026-11-19 に決めました。

## 分かったこと

- このリポジトリは TypeScript 7.0.2 を使っています。TypeScript 7.0 には、プログラムから使う API がありません。
- typescript-eslint（8.73.0）は、`typescript` の対応範囲が `>=4.8.4 <6.1.0` です（パッケージの `peerDependencies` で確認）。TypeScript 7 と一緒には使えません。tsgo を使って型の情報を得る仕組みは、実験段階です。
- Oxlint の型の情報を使う検査（`oxlint-tsgolint`）は、TypeScript 7 の実装（typescript-go）の上に作られています。v7 が TypeScript 7.0.2 に合わせてあり、2026-07-22 に安定版になりました。
- Oxlint 1.94.0 と oxlint-tsgolint 7 を `src`・`test`・`scripts` に当てた結果は、次のとおりでした。
  - 標準のルール：警告 3 件。どれも書き方の好み。
  - 型の情報を使うルール：`no-floating-promises` 5 件のうち 3 件は、ハーネスの stdin への書き込みの Promise を受けていない箇所でした。ハーネスが stdin を読まずに落ちると、中継も落ちる不具合でした（PR #54 で直した）。`no-base-to-string` の 2 件は、値がオブジェクトのときに `[object Object]` という文字列になる箇所でした。
  - `await-thenable` の 21 件は誤検出でした。`@types/bun` が `expect(...).rejects` を `Matchers<unknown>` と宣言していて、`toThrow()` の戻り値が `void` になります。実行時は Promise を返します。

## 決めたこと

- 一般の lint は Oxlint で行う。設定はリポジトリ直下の `.oxlintrc.json`。
- 型の情報を使う検査（`typeAware`）を有効にする。
- 警告も失敗にする（`denyWarnings`）。警告のまま残すと、増えても気づかないため。
- `test/` では `typescript/await-thenable` を切る。上の誤検出のため。
- `bun run check` で、`tsc --noEmit` のあと、`scripts/check.ts` の前に動かす。CI でも動く。
- `scripts/check.ts` は残す。対象が Markdown・シェル・`package.json`・CI の YAML に及び、Oxlint のルールでは書けないため。

## Considered Options

- **ESLint と typescript-eslint。** 一般には第一の選択肢で、プラグインも最も多い。ただし、上のとおり TypeScript 7 と一緒には使えない。型の情報を使わないルールだけなら使えるが、このリポジトリで最も効いた `no-floating-promises` が使えない。
- **Biome。** lint と formatter を 1 つで行える。型の情報を使う検査は、Oxlint ほど揃っていない。formatter は、正しさの検査ではなく、全体の書式が変わる大きな差分になるので、今は入れない。
- **入れない（`tsc` の `strict` と `check.ts` だけ）。** 上の不具合は、`tsc` でもテストでも見つかっていなかった。

## Consequences

- TypeScript 7.1 で API が入り、typescript-eslint が対応したら、ESLint に移るかを、あらためて決められます。移る理由がなければ、Oxlint のままにします。
- `@types/bun` の宣言が直ったら、`test/` の `await-thenable` を戻せます。
- 使われていないファイル・export の検査（knip）、ミューテーションテスト（StrykerJS）は、#53 で検討し、見送りました。
