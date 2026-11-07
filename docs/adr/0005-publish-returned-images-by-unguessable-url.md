---
status: accepted
---

# Claude が返す画像は、推測できない URL で 7 日間公開して LINE に渡す

LINE の Bot は、画像を LINE へ直接アップロードできない。画像メッセージには HTTPS の URL を渡し、LINE はその URL から画像を取得する。認証を付ける方法はない。LINE は画像を保存せず、開かれるたびに URL から取りにくるので、URL が切れると過去の画像も開けなくなる。

ユーザーと相談し、Claude が `cc-connect send --image` で返した画像を、アダプターが公開して LINE に渡すことにした（2026-11-07）。

- アダプターは、画像を `.local/line/media/` に保存し、Webhook と同じトンネルで `/media/<名前>` として公開する。名前は 256 ビットの乱数にし、一覧は出さない。
- 7 日たったら消す。受け取った添付と同じ期間にした。
- 公開する URL の先頭は、署名を確かめた Webhook が届いたホスト名（`X-Forwarded-Proto: https` のときの `Host`）から決める。Quick Tunnel でも設定が要らない。固定の URL を使うときは `CCJ_LINE_PUBLIC_URL` で指定する。
- URL はログに出さない。送るたびにルームでの承認が要るので、意図しない画像は出ない。

## Considered Options

- 画像を返さない。作業場所の中身を外へ出す経路ができない一方、Claude が作った図やグラフを LINE で見られない。
- 公開期間を 1 日などに短くする。公開している時間は減るが、それより前の画像は LINE で開けなくなる。

## Consequences

- URL を知っている人なら、誰でも 7 日間見られる。画像を開いた人や、転送された人も含む。通信は Cloudflare を通るので、Cloudflare からは中身が見える（Webhook と同じ）。取得に来るのが LINE か利用者の端末かは見分けられない（LINE は取得元の IP を公開しておらず、User-Agent は偽装できる）ため、取得元では絞らない。
- Quick Tunnel は起動のたびに URL が変わる。アダプターを再起動すると、それより前に返した画像は開けなくなる。Named Tunnel にすれば解消する。
- トンネルで公開する範囲が、Webhook の受け口だけから、`/media/` を加えたものに広がる。
