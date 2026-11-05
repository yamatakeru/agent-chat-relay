---
status: accepted
---

# LINE も cc-connect 標準の LINE platform ではなく、Bridge 経由の自作アダプターで接続する

本番ではグループでメンションされたときだけ反応させたい。しかし cc-connect v1.5.0 の LINE platform には、Feishu・Slack・Discord などにある `group_reply_all = false` に相当する設定がなく、グループの全発言に反応する。本体へ PR を出しても、未処理の PR が 300 件を超え、LINE の改善 PR #854 も半年間取り込まれていないため、早期の取り込みは見込めない。fork を保守し続けることも避けたい。そのため、LINE WORKS・Chatwork と同じ Bridge 基盤の上に LINE アダプターを自作する。標準の LINE platform は、まず検証で実際の挙動を測るために使う。測定で別の致命的な問題が見つかった場合は、この判断を見直す。

## Considered Options

- 本体へ PR を出し、取り込まれるまで標準の LINE platform で待つ。自前のコードは最小だが、本番に入る時期が読めない。
- PR を出しつつ、自前の fork で運用する。すぐ使えるが、取り込まれるまで fork の保守が続く。

## Consequences

- メンション判定、Reply を優先し期限切れなら Push で返す返信方式、将来の承認者の制限を、アダプター側で実装できる。
- Bridge の制約を引き受ける。message には到達確認（ACK）がなく、切断中の reply は失われ、`allow_from` もない。返信が失われた可能性があるときはルームへ通知し、送信者の許可はアダプター側で判定する。
- v1.5.0 では、ネイティブ platform がないプロジェクトは起動できない。これを回避する手段が必要になる。
- 本体の LINE platform に同等の設定が入った場合は、標準の platform へ戻すことを再検討する。
