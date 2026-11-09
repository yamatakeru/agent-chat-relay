# 旧実装（cc-connect 経由）

cc-connect 1.5.0 に cloud_web でつなぐ LINE アダプターと、その検証の記録。ADR 0006 で cc-connect をやめたため、参照用に残している。保守はしない。

- 中身：`cmd/line`、`internal/`（cloudweb・line・workspace・jsonfile）、`scripts/`、`examples/`（cc-connect の設定）、`docs/`（仕様・手順・検証の記録）
- 別の Go モジュールにしてあり、`old/` の中で `mise exec -- go test ./...` が通る。
- `scripts/` と `examples/` は、リポジトリ直下にあった前提のパスのまま。cc-connect も削除したので、そのままでは動かない。
- LINE の仕様の判断（`docs/line-adapter.md`）と、実機の記録（`docs/line-adapter-setup.md`）は、新しい実装でも参照する。
