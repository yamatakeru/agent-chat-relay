// 評価用の会話（docs/addressing-eval.md）。test/e2e/addressing.ts（エージェントが答えるか・黙るか）と、test/e2e/addressing-jev.ts（Jev が他人宛てと判定するか）で使う

export type Want = "answer" | "silent" | "either"
/**
 * bot は、その発言のあとの Bot の返事。Jev の評価で、直前の発言として渡す（エージェントの評価では、実際のエージェントが返事する）。
 * 実際の評価で、新しい案内のエージェントが返した返事を、短くしたもの
 */
export type Line = { user: "A" | "B" | "C"; text: string; want: Want; mention?: boolean; burst?: number; bot?: string }

export const USERS = { A: "Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", B: "Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", C: "Uccccccccccccccccccccccccccccccccc" }
export const NAMES = { A: "アリス", B: "ボブ", C: "カオル" }
export const ROOM = "C111aaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

/**
 * 評価用の会話。answer：Bot が答えるべき、silent：黙るべき、either：どちらでもよい（数えない）。
 * answer は、だれに向けたかを書いていない問いかけ、全員や「だれか」に向けた問い、Bot との会話の続き。
 * silent は、名前で特定の人に向けた発言（構造の印はない）、人どうしのやりとり、Bot が役に立てない雑談と相づち
 */
export const MAIN: Line[] = [
  { user: "A", text: "今日からこのルームでもよろしくね。", want: "answer", mention: true, bot: "よろしくお願いします。調べものやコードのことなど、いつでも声をかけてください。" },
  { user: "B", text: "おはようございます", want: "either" },
  { user: "A", text: "ボブさん、昨日のレビューありがとう", want: "silent" },
  { user: "B", text: "いえいえ、こちらこそ助かりました", want: "silent" },
  { user: "A", text: "Python で辞書をキーの順に並べ替えるのって、どう書くんだっけ？", want: "answer", bot: "dict(sorted(d.items())) で、キーの順に並べた辞書になります。" },
  { user: "B", text: "sorted に items を渡すやつですね", want: "silent" },
  { user: "A", text: "なるほど、ありがとう", want: "either" },
  { user: "C", text: "みんな、UTC の 15 時って日本時間だと何時だっけ？", want: "answer", bot: "日本時間は UTC より 9 時間進んでいるので、24 時（翌日の 0 時）です。" },
  { user: "A", text: "カオルさん、例の見積もりって今日中に送れそう？", want: "silent" },
  { user: "C", text: "夕方には送ります！", want: "silent" },
  { user: "B", text: "だれか、git で直前のコミットのメッセージだけ直すコマンド覚えてる？", want: "answer", bot: "git commit --amend -m で直せます。push 済みなら、強制 push が必要です。" },
  { user: "A", text: "お昼どうする？", want: "silent" },
  { user: "C", text: "そば行きたいです", want: "silent" },
  { user: "A", text: 'この JSON、どこがおかしいんだろう {"a": 1, "b": [2, 3,]}', want: "answer", bot: "配列の 3 のあとのカンマが余分です。JSON では、最後の要素のあとにカンマを置けません。" },
  { user: "A", text: "じゃあ、末尾のカンマを消せば読めるようになる？", want: "answer", bot: "はい、末尾のカンマを消せば読めます。" },
  { user: "C", text: "アリスさん、その JSON って何に使うやつですか？", want: "silent" },
  { user: "A", text: "デプロイの設定ファイルだよ", want: "silent" },
  { user: "B", text: "ちなみに 1 マイルって何キロだっけ", want: "answer", bot: "1 マイルは約 1.609 キロメートルです。" },
  { user: "C", text: "マイル表記、分かりにくいですよね", want: "silent" },
  { user: "A", text: "ボブさん、来週の休みの件、もう上長に伝えた？", want: "silent" },
  { user: "B", text: "まだです、今日中に伝えます", want: "silent" },
  { user: "B", text: "これ、来週までにだれかやっておいてくれると嬉しいなあ", want: "either" },
  { user: "B", text: "あとで飲み物買ってきます", want: "silent", burst: 1 },
  { user: "A", text: "ありがとう、お茶でお願い", want: "silent", burst: 1 },
  { user: "C", text: "正規表現で、行頭の空白だけ消すのってどう書くんでしたっけ？", want: "answer", burst: 1, bot: "行頭の空白（^ に続く空白）を空文字に置き換えます。複数行なら m フラグを付けます。" },
  { user: "A", text: "カオルさん、それ急ぎ？", want: "silent", burst: 1 },
]

/** main と分類は同じで、言い回しを変え、迷いやすい発言を足した会話 */
export const HOLDOUT: Line[] = [
  { user: "B", text: "今日も一日がんばりましょう", want: "either", mention: true, bot: "よろしくお願いします。何かあれば声をかけてください。" },
  { user: "C", text: "今日は暑いですね", want: "silent" },
  { user: "A", text: "ほんとに。エアコン強めにしようかな", want: "silent" },
  { user: "B", text: "これって英語でなんて言うんだっけ、「締め切りを延ばす」", want: "answer", bot: "extend the deadline が一般的です。push back the deadline とも言います。" },
  { user: "B", text: "もう少しカジュアルな言い方もある？", want: "answer", bot: "push the deadline back や、give us a bit more time がカジュアルです。" },
  { user: "C", text: "ボブさん、それ先方へのメールで使うんですか？", want: "silent" },
  { user: "B", text: "そうそう、午後に送る予定", want: "silent" },
  { user: "A", text: "了解です", want: "silent" },
  { user: "C", text: "計算得意な人いますか？ 2,480 円の 3 割引きっていくら？", want: "answer", bot: "2,480 × 0.7 で、1,736 円です。" },
  { user: "A", text: "カオルさん、それ経費で落ちるやつ？", want: "silent" },
  { user: "C", text: "たぶん大丈夫です", want: "silent" },
  { user: "A", text: "シェルで、カレントディレクトリの中の一番大きいファイルを探すには？", want: "answer", bot: "ls -S | head -1 で見つかります。サブディレクトリも含めるなら find と du を組み合わせます。" },
  { user: "B", text: "それ、ボットに聞いてみたら？", want: "either" },
  { user: "C", text: "なんでこのビルド、こんなに遅いんだろうね", want: "either" },
  { user: "B", text: "アリスさん、明日の打ち合わせ、10 時からで合ってます？", want: "silent" },
  { user: "A", text: "合ってます！", want: "silent" },
  { user: "C", text: "ねえ、HTTP の 418 ってなんのステータスだっけ", want: "answer", bot: "418 は「I am a teapot」です。エイプリルフールの RFC 2324 が由来です。" },
  { user: "C", text: "へえ、そんなのあるんだ", want: "silent" },
  { user: "B", text: "今週の金曜、飲み会行ける人？", want: "silent" },
  { user: "A", text: "行きます〜", want: "silent" },
  { user: "B", text: "TypeScript で、配列から重複を取り除く一番短い書き方って？", want: "answer", bot: "[...new Set(arr)] です。" },
  { user: "A", text: "ボブさん、例の資料あとで見ておきますね", want: "silent", burst: 1 },
  { user: "B", text: "ありがとうございます！", want: "silent", burst: 1 },
  { user: "C", text: "ところで、cron で毎週月曜の朝 9 時って、どう書くんでしたっけ", want: "answer", burst: 1, bot: "0 9 * * 1 です。" },
  { user: "A", text: "お先に失礼します", want: "silent", burst: 1 },
]


/**
 * Jev の評価だけで使う、迷いやすい発言の会話（ADR 0029）。
 * Bot の問いへの答え、ほかの人の名前を出しただけの問い、ほかの人への問いのあとに続けた全員への問いなど、外してはいけない発言を多めに入れた
 */
export const JEV_EXTRA: Line[] = [
  { user: "A", text: "このルームの議事録、要点だけまとめてほしい", want: "answer", mention: true, bot: "まとめます。対象は今週の分だけでよいですか？ それとも先月からにしますか？" },
  { user: "A", text: "今週の分だけでいいよ", want: "answer", bot: "分かりました。今週の議事録の要点をまとめて送ります。" },
  { user: "B", text: "カオルさん、議事録のフォルダの場所ってどこでしたっけ", want: "silent" },
  { user: "C", text: "共有ドライブの「会議」の下です", want: "silent" },
  { user: "B", text: "カオルさんが言ってた Docker のエラー、どうやったら直るんだろう", want: "answer", bot: "エラーの全文を貼ってもらえれば、原因を調べます。" },
  { user: "C", text: "port is already allocated って出てます", want: "answer", bot: "そのポートを別のコンテナが使っています。docker ps で探して止めてください。" },
  { user: "A", text: "ボブさん、カオルさん、どっちか分かる？ 来月の勉強会の日程", want: "silent" },
  { user: "B", text: "第 2 金曜だったと思います", want: "silent" },
  { user: "A", text: "ボブさん、ついでに聞くけど、Go の goroutine ってスレッドと何が違うの？", want: "either" },
  { user: "B", text: "うーん、自信ないです", want: "silent" },
  { user: "A", text: "了解、ありがとう", want: "silent" },
  { user: "C", text: "さっきの docker ps、止めたら動きました！", want: "answer", bot: "よかったです。" },
  { user: "B", text: "アリスさん、さっきの件、あとで電話します", want: "silent" },
  { user: "A", text: "OK", want: "silent" },
  { user: "C", text: "アリスさんの言ってた勉強会って、何をやるんでしたっけ？", want: "either" },
  { user: "A", text: "Rust 入門だよ", want: "silent" },
  { user: "B", text: "それなら、Rust の所有権を一言で説明するとどうなる？", want: "answer", bot: "値ごとに持ち主が 1 つだけ決まっていて、持ち主がいなくなると値も片付けられる、という規則です。" },
  { user: "C", text: "なるほど、わかりやすい", want: "either" },
]
