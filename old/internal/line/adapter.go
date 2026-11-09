// Package line は、LINE と cc-connect（cloud_web）の間をつなぐアダプター。
// 振る舞いの仕様は docs/line-adapter.md にある。
package line

import (
	"cmp"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/yamatakeru/cc-connect-jtc-adapters/old/internal/cloudweb"
)

// ルームへ返す案内。
const (
	msgUnregistered = "このグループは登録されていないため、動作しません。"
	msgStopped      = "いまは停止中のため、受け付けていません。あとで送り直してください。"
	msgRedelivered  = "停止中に届いたため、この発言は処理していません。必要なら送り直してください。"
	msgLost         = "接続が切れたため、返事が届かなかった可能性があります。必要なら送り直してください。"
	msgApproveAll   = "このルームでは allow all は使えません。allow か deny で返信してください。"
	msgQuota        = "今月の送信の上限に達したため、返事を送れませんでした。"
	msgInternal     = "内部のエラーのため、処理できませんでした。"
	msgTooLarge     = "大きすぎるため、受け取れませんでした（画像は 5MB、ファイルは 20MB まで）。"
	msgFetchFailed  = "画像またはファイルを受け取れませんでした。送り直してください。"
	msgBadImage     = "LINE に送れない画像のため、送りませんでした（JPEG か PNG で、10MB まで）。"
	msgNoPublicURL  = "画像を公開する URL が分からないため、送りませんでした。"
)

const (
	// Reply トークンは受信から 1 分以内に 1 回だけ使える。余裕を見て 50 秒までにする。
	replyTokenTTL = 50 * time.Second
	// LINE の再送に備え、webhookEventId を覚えておく期間。
	seenTTL = 24 * time.Hour
	// ルームごとに、送信を待たせておける数。LINE に送れない状態が続いたときに溢れた分は捨てる。
	maxOutbox = 100

	// 受け取る画像とファイルの上限。画像は Claude が受け付ける大きさに合わせる。
	maxInImageBytes = 5 << 20
	maxInFileBytes  = 20 << 20
	// 画像やファイルを預かり、同じ人の次の依頼に添える期間と、1 人あたりの数。
	attachmentTTL  = 10 * time.Minute
	maxAttachments = 20
)

// LINE のメッセージ ID（数字）。取得先の URL に入れるので形を確かめる。
var messageIDPattern = regexp.MustCompile(`^[0-9]{1,32}$`)

// 公開 URL に使うホスト名（Webhook の Host ヘッダー）の形。
var hostPattern = regexp.MustCompile(`^[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$`)

// Sender は、cc-connect へ発言を渡す口（cloudweb.Server）。
type Sender interface {
	Send(cloudweb.Message) error
	Connected() bool
}

// Binder は、ルームの作業場所を割り当てる口（workspace.Bindings）。
type Binder interface {
	Ensure(roomID string) error
}

// Messenger は、LINE とやり取りする口（Client）。
type Messenger interface {
	Reply(ctx context.Context, replyToken string, msgs []OutMessage) error
	Push(ctx context.Context, to string, msgs []OutMessage) error
	Content(ctx context.Context, messageID string, max int64) ([]byte, string, error)
}

// Publisher は、LINE へ返す画像を公開する口（Media）。
type Publisher interface {
	Publish(data []byte) (orig, preview string, err error)
}

// RoomLookup は、ルームの登録を引く口（Rooms）。
type RoomLookup interface {
	Lookup(id string) (Room, bool)
}

// Config は、アダプターの設定。
type Config struct {
	ChannelSecret string
	AllowFrom     map[string]bool // 送信者の許可（userId）
	Platform      string          // cc-connect の cloud_web の name
	// PublicURL は、画像を公開する URL の先頭（例：https://example.com）。空なら、署名を確かめた
	// Webhook が届いたホスト名（トンネルの URL）を使う
	PublicURL string
}

type waitKind int

const (
	waitNone       waitKind = iota
	waitPermission          // 承認待ち
	waitQuestion            // Claude からの質問への回答待ち
)

type replyToken struct {
	token string
	at    time.Time
}

// outgoing は、LINE へ送る 1 回分。
type outgoing struct {
	msgs   []OutMessage
	image  []byte // Claude が返した画像。送る直前に公開して画像メッセージにする
	token  string // 指定があれば、この Reply トークンで返す（参加時の案内）
	notice bool   // 案内：Reply でだけ送る（通数を使わない）
}

// attachment は、預かっている画像かファイル。
type attachment struct {
	at    time.Time
	image bool
	data  cloudweb.Attachment
}

type roomState struct {
	id      string
	outbox  []outgoing // LINE への送信待ち（順に送る）
	sending bool       // LINE へ送っている途中

	// 利用者ごと（userId）の、預かっている画像とファイル、取得中の数、取得を待っている発言
	attachments map[string][]attachment
	downloading map[string]int
	deferred    map[string][]func()

	tokens []replyToken       // 未使用の Reply トークン
	wait   waitKind           // 承認待ち・回答待ち
	held   []cloudweb.Message // 待ちの間に保留した発言（受信モードが「すべて」のとき）
	busy   bool               // 渡した依頼の返事をまだ受け取っていない
	quota  bool               // 通数の上限で Push できなかった（次の Reply で伝える）
}

// Adapter は、状態の読み書きを 1 つのゴルーチン（Run）で順に行う（ルームの状態に鍵をかけないため）。
// LINE への送信は時間がかかるので、別のゴルーチンで行い、結果だけを Run に戻す。
// 送信はルームごとに 1 つずつ順に行い、ルームが違えば並行に行う。
type Adapter struct {
	cfg   Config
	line  Messenger
	cc    Sender
	bind  Binder
	rooms RoomLookup
	media Publisher
	now   func() time.Time
	// spawn は、io を Run の外で実行し、終わったら done を Run で実行する（テストでは同期的に置き換える）
	spawn func(io, done func())

	ctx    context.Context // Run が終わると取り消される（送信中の HTTP も止まる）
	stop   context.CancelFunc
	events chan func()
	state  map[string]*roomState
	seen   map[string]time.Time
	// publicURL は、画像を公開する URL の先頭（Config.PublicURL か、最後に届いた Webhook のホスト名）
	publicURL string
}

// New は Adapter を作る。Run を別のゴルーチンで動かしてから使う。
func New(cfg Config, line Messenger, cc Sender, bind Binder, rooms RoomLookup, media Publisher) *Adapter {
	ctx, stop := context.WithCancel(context.Background())
	a := &Adapter{
		cfg: cfg, line: line, cc: cc, bind: bind, rooms: rooms, media: media, now: time.Now,
		ctx: ctx, stop: stop, publicURL: strings.TrimRight(cfg.PublicURL, "/"),
		events: make(chan func(), 256),
		state:  map[string]*roomState{},
		seen:   map[string]time.Time{},
	}
	a.spawn = func(io, done func()) {
		go func() {
			io()
			a.enqueue(done)
		}()
	}
	return a
}

// Run は、ctx が終わるまで処理を順に実行する。
func (a *Adapter) Run(ctx context.Context) {
	defer a.stop()
	for {
		select {
		case f := <-a.events:
			f()
		case <-ctx.Done():
			return
		}
	}
}

func (a *Adapter) enqueue(f func()) {
	select {
	case a.events <- f:
	case <-a.ctx.Done():
	}
}

// OnFrame は、cc-connect から届いた返事を受け取る（cloudweb.Server.OnFrame に渡す）。
func (a *Adapter) OnFrame(f cloudweb.Frame) { a.enqueue(func() { a.handleFrame(f) }) }

// OnDisconnect は、cc-connect との接続が切れたことを受け取る。
func (a *Adapter) OnDisconnect() { a.enqueue(a.handleDisconnect) }

// ServeHTTP は LINE の Webhook の受け口。署名を確かめ、イベントを順に処理へ回して、すぐ 200 を返す。
func (a *Adapter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !verifySignature(a.cfg.ChannelSecret, body, r.Header.Get("X-Line-Signature")) {
		slog.Warn("line: invalid signature", "remote", r.RemoteAddr)
		http.Error(w, "invalid signature", http.StatusBadRequest)
		return
	}
	var wb webhookBody
	if err := json.Unmarshal(body, &wb); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// トンネルを通ってきた Webhook のホスト名を、画像を公開する URL に使う
	if a.cfg.PublicURL == "" && r.Header.Get("X-Forwarded-Proto") == "https" && hostPattern.MatchString(r.Host) {
		base := "https://" + r.Host
		a.enqueue(func() { a.publicURL = base })
	}
	for _, ev := range wb.Events {
		a.enqueue(func() { a.handleEvent(ev) })
	}
	w.WriteHeader(http.StatusOK)
}

func (a *Adapter) room(id string) *roomState {
	st := a.state[id]
	if st == nil {
		st = &roomState{id: id, attachments: map[string][]attachment{}, downloading: map[string]int{}, deferred: map[string][]func(){}}
		a.state[id] = st
	}
	return st
}

// roomOf は、イベントの発生元のルーム ID と、cloud_web の chat_type を返す。
func roomOf(s source) (string, string) {
	switch s.Type {
	case "group":
		return s.GroupID, "group"
	case "room":
		return s.RoomID, "group"
	case "user":
		return s.UserID, "direct"
	}
	return "", ""
}

func (a *Adapter) duplicate(id string) bool {
	if id == "" {
		return false
	}
	now := a.now()
	if _, ok := a.seen[id]; ok {
		return true
	}
	if len(a.seen) >= 10000 {
		maps.DeleteFunc(a.seen, func(_ string, t time.Time) bool { return now.Sub(t) > seenTTL })
	}
	a.seen[id] = now
	return false
}

func (a *Adapter) handleEvent(ev event) {
	if a.duplicate(ev.WebhookEventID) || (ev.Mode != "" && ev.Mode != "active") {
		return
	}
	roomID, chatType := roomOf(ev.Source)
	if roomID == "" {
		return
	}

	if ev.Type == "join" {
		if _, ok := a.rooms.Lookup(roomID); !ok {
			slog.Info("line: joined unregistered group", "group", roomID)
			if ev.ReplyToken != "" {
				a.queue(a.room(roomID), outgoing{msgs: textMessages(msgUnregistered), token: ev.ReplyToken, notice: true})
			}
		}
		return
	}
	if ev.Type != "message" || ev.Message == nil {
		return
	}
	switch ev.Message.Type {
	case "text", "image", "file":
	default:
		return
	}

	// 送信者の許可とルームの登録。userId と groupId は登録のためにログへ出す（ログは .local/ にだけ残す）
	user := ev.Source.UserID
	if !a.cfg.AllowFrom[user] {
		slog.Info("line: message from unauthorized user", "user", user, "room", roomID)
		return
	}
	all := false // 受信モードが「すべて」
	if chatType == "group" {
		room, ok := a.rooms.Lookup(roomID)
		if !ok {
			slog.Info("line: message in unregistered group", "group", roomID)
			return
		}
		all = room.Mode == ModeAll
	}

	st := a.room(roomID)
	if ev.ReplyToken != "" {
		st.tokens = append(st.tokens, replyToken{token: ev.ReplyToken, at: a.now()})
	}
	if ev.Message.Type != "text" {
		a.receiveAttachment(ev, st, user)
		return
	}
	a.handleText(ev, st, chatType, all)
}

// handleText は、テキストの発言を cc-connect へ渡すか、保留するか、捨てるかを決める。
func (a *Adapter) handleText(ev event, st *roomState, chatType string, all bool) {
	user := ev.Source.UserID
	if st.downloading[user] > 0 {
		// 先に送られた画像やファイルを取得し終えてから扱う（依頼に添えるため）
		st.deferred[user] = append(st.deferred[user], func() { a.handleText(ev, st, chatType, all) })
		return
	}
	roomID := st.id
	text := ev.Message.Text
	mentioned := chatType == "direct" // 1 対 1 トークの発言は、すべて Bot あて
	if mn := ev.Message.Mention; mn != nil {
		mentioned = mentioned || slices.ContainsFunc(mn.Mentionees, func(m mentionee) bool { return m.IsSelf })
		text = stripSelfMentions(text, mn.Mentionees)
	}
	if text == "" {
		return
	}
	word, isApproval := approvalWord(text)

	forward, hold := false, false
	switch {
	case isApproval && st.wait != waitPermission:
		// 承認待ちでない承認の言葉は無視する
	case isApproval:
		forward, text = true, word
	case st.wait == waitPermission:
		// cc-connect は承認待ちの間、発言の単語（ok・no なども）を承認の返事として読む。
		// 承認の言葉以外は渡さず、待ちが終わってから渡す
		hold = mentioned || all
	case st.wait == waitQuestion:
		forward, hold = mentioned, !mentioned && all
	default:
		forward = mentioned || all
	}

	msg := cloudweb.Message{
		MsgID: ev.Message.ID, ChatID: roomID, UserID: user, Content: text,
		ReplyCtx: roomID, ChatType: chatType, Mentioned: true,
	}
	// cc-connect は承認待ちの間に allow all を受け取ると、以降の承認をすべて省く。
	// 承認の言葉と同じく、承認待ちの間はメンションなしの「allow all」だけの発言にも断りを返す
	blockAll := (forward || hold) && isApproveAll(text) ||
		st.wait == waitPermission && isApproveAllWord(text)
	switch {
	case blockAll:
		a.notify(st, msgApproveAll)
		return
	case !forward && !hold:
		return
	case ev.DeliveryContext.IsRedelivery:
		// アダプターが止まっている間に届き、あとで再送された依頼は実行しない
		a.notify(st, msgRedelivered)
		return
	}
	var atts []attachment
	if !isApproval {
		atts = a.takeAttachments(st, user)
		msg.Images, msg.Files = splitAttachments(atts)
	}
	if hold {
		st.held = append(st.held, msg)
		return
	}
	if !a.forward(st, msg, !isApproval) && len(atts) > 0 {
		// 渡せなかったら預かり直す。送り直した依頼に添えるため
		st.attachments[user] = append(atts, st.attachments[user]...)
	}
}

// receiveAttachment は、画像やファイルを LINE から取得して預かる。同じ人の次の依頼に添える。
func (a *Adapter) receiveAttachment(ev event, st *roomState, user string) {
	m := ev.Message
	if ev.DeliveryContext.IsRedelivery || !messageIDPattern.MatchString(m.ID) {
		return
	}
	isImage := m.Type == "image"
	limit := int64(maxInFileBytes)
	if isImage {
		if m.ContentProvider == nil || m.ContentProvider.Type != "line" {
			return // 外部の URL にある画像は取得しない
		}
		limit = maxInImageBytes
	} else if m.FileSize > limit {
		a.notify(st, msgTooLarge)
		return
	}

	var att cloudweb.Attachment
	var err error
	st.downloading[user]++
	a.spawn(func() {
		var data []byte
		data, att.MimeType, err = a.line.Content(a.ctx, m.ID, limit)
		if err == nil {
			att.MimeType = cmp.Or(att.MimeType, http.DetectContentType(data))
			att.Data, att.FileName = base64.StdEncoding.EncodeToString(data), m.FileName
		}
	}, func() {
		switch {
		case errors.Is(err, ErrTooLarge):
			a.notify(st, msgTooLarge)
		case err != nil:
			slog.Warn("line: get content", "room", st.id, "error", err)
			a.notify(st, msgFetchFailed)
		default:
			list := append(st.attachments[user], attachment{at: a.now(), image: isImage, data: att})
			st.attachments[user] = list[max(0, len(list)-maxAttachments):]
			time.AfterFunc(attachmentTTL, func() { a.enqueue(func() { a.expireAttachments(st, user) }) })
		}
		if st.downloading[user]--; st.downloading[user] > 0 {
			return
		}
		delete(st.downloading, user)
		deferred := st.deferred[user]
		delete(st.deferred, user)
		for _, f := range deferred {
			f()
		}
	})
}

// takeAttachments は、預かっている画像とファイルのうち期限内のものを取り出す。
func (a *Adapter) takeAttachments(st *roomState, user string) []attachment {
	a.expireAttachments(st, user)
	atts := st.attachments[user]
	delete(st.attachments, user)
	return atts
}

func splitAttachments(atts []attachment) (images, files []cloudweb.Attachment) {
	for _, att := range atts {
		if att.image {
			images = append(images, att.data)
		} else {
			files = append(files, att.data)
		}
	}
	return images, files
}

// expireAttachments は、預かってから期限を過ぎた画像とファイルを黙って捨てる。
func (a *Adapter) expireAttachments(st *roomState, user string) {
	now := a.now()
	list := slices.DeleteFunc(st.attachments[user], func(att attachment) bool { return now.Sub(att.at) >= attachmentTTL })
	if len(list) == 0 {
		delete(st.attachments, user)
		return
	}
	st.attachments[user] = list
}

// forward は、割り当てを確かめてから cc-connect へ発言を渡す。渡せなければ案内を返し、false を返す。
func (a *Adapter) forward(st *roomState, msg cloudweb.Message, request bool) bool {
	if !a.cc.Connected() {
		a.notify(st, msgStopped)
		return false
	}
	if err := a.bind.Ensure(msg.ChatID); err != nil {
		slog.Error("line: ensure workspace", "error", err)
		a.notify(st, msgInternal)
		return false
	}
	if err := a.cc.Send(msg); err != nil {
		slog.Warn("line: send to cc-connect", "error", err)
		a.notify(st, msgStopped)
		return false
	}
	if request {
		st.busy = true
	}
	return true
}

func (a *Adapter) handleFrame(f cloudweb.Frame) {
	roomID := f.ReplyCtx
	if roomID == "" {
		roomID = strings.TrimPrefix(f.SessionKey, a.cfg.Platform+":")
	}
	if roomID == "" {
		return
	}
	st := a.room(roomID)
	if f.Type == "image" {
		if len(f.Data) > 0 {
			a.queue(st, outgoing{image: f.Data})
		}
		return
	}
	switch classify(f.Content) {
	case kindPermissionPrompt:
		st.wait = waitPermission
		a.deliver(st, withoutAllowAll(f.Content))
	case kindPermissionHint:
		a.deliver(st, withoutAllowAll(f.Content))
	case kindQuestion:
		st.wait = waitQuestion
		a.deliver(st, f.Content)
	case kindQueued:
		// 順番待ちの受け付けは出さない（Reply トークンを答えのために残す）
	case kindHelper:
		// 「✅ 許可しました」などは出さない。承認待ちはここで終わる
		st.wait = waitNone
		a.flush(st)
	default:
		st.wait, st.busy = waitNone, false
		a.deliver(st, f.Content)
		a.flush(st)
	}
}

// flush は、待ちの間に保留した発言を順に渡す。
func (a *Adapter) flush(st *roomState) {
	held := st.held
	st.held = nil
	for _, m := range held {
		a.forward(st, m, true)
	}
}

func (a *Adapter) handleDisconnect() {
	for _, st := range a.state {
		if st.busy || st.wait != waitNone || len(st.held) > 0 {
			a.deliver(st, msgLost)
		}
		st.busy, st.wait, st.held = false, waitNone, nil
	}
}

// takeToken は、未使用で新しい Reply トークンを 1 つ取り出す。
func (st *roomState) takeToken(now time.Time) (string, bool) {
	st.tokens = slices.DeleteFunc(st.tokens, func(t replyToken) bool { return now.Sub(t.at) >= replyTokenTTL })
	if len(st.tokens) == 0 {
		return "", false
	}
	t := st.tokens[len(st.tokens)-1]
	st.tokens = st.tokens[:len(st.tokens)-1]
	return t.token, true
}

// deliver は、返事を送信待ちに加える。使える Reply トークンがあれば Reply、なければ Push で送る。
func (a *Adapter) deliver(st *roomState, text string) {
	if bubbles := splitBubbles(text); len(bubbles) > 0 {
		a.queue(st, outgoing{msgs: textMessages(bubbles...)})
	}
}

// notify は、案内を送信待ちに加える。案内は Reply でだけ返す（通数を使わない）。
func (a *Adapter) notify(st *roomState, text string) {
	a.queue(st, outgoing{msgs: textMessages(text), notice: true})
}

func (a *Adapter) queue(st *roomState, out outgoing) {
	if len(st.outbox) >= maxOutbox {
		slog.Error("line: outbox full, message dropped", "room", st.id)
		return
	}
	st.outbox = append(st.outbox, out)
	a.sendNext(st)
}

// sendNext は、ルームの送信待ちの先頭を送る。Reply トークンは送る直前に選ぶ（待つ間に新しいトークンが届くため）。
func (a *Adapter) sendNext(st *roomState) {
	for !st.sending && len(st.outbox) > 0 {
		out := st.outbox[0]
		st.outbox = st.outbox[1:]
		tok := out.token
		if tok == "" {
			tok, _ = st.takeToken(a.now())
		}
		if out.notice && tok == "" {
			slog.Info("line: notice not sent (no reply token)", "notice", out.msgs[0].Text)
			continue
		}
		quota := tok != "" && !out.notice && st.quota
		publicURL := a.publicURL
		var res sendResult
		var noticed bool // 通数の上限の案内を書き添えた
		st.sending = true
		a.spawn(func() {
			msgs := out.msgs
			if out.image != nil {
				msgs = a.imageMessages(publicURL, out.image)
			}
			replyMsgs, pushMsgs := msgs, msgs
			if quota && len(msgs) < maxBubbles {
				replyMsgs, noticed = append(textMessages(msgQuota), msgs...), true
			}
			if out.notice {
				pushMsgs = nil // 案内は Push しない
			}
			res = a.send(st.id, tok, replyMsgs, pushMsgs)
		}, func() {
			st.sending = false
			if noticed && res.replied {
				st.quota = false
			}
			if res.quotaExceeded {
				// このときは使える Reply トークンがない。次に Reply で送るときに書き添える
				st.quota = true
			}
			a.sendNext(st)
		})
	}
}

// imageMessages は、画像を公開して画像メッセージにする（Run の外で動く）。送れなければ理由の文面にする。
// 公開した URL はログに出さない。
func (a *Adapter) imageMessages(publicURL string, data []byte) []OutMessage {
	if publicURL == "" {
		return textMessages(msgNoPublicURL)
	}
	orig, preview, err := a.media.Publish(data)
	if errors.Is(err, ErrUnsupportedImage) {
		return textMessages(msgBadImage)
	}
	if err != nil {
		slog.Error("line: publish image", "error", err)
		return textMessages(msgInternal)
	}
	return []OutMessage{{Type: "image", OriginalContentURL: publicURL + "/media/" + orig, PreviewImageURL: publicURL + "/media/" + preview}}
}

type sendResult struct {
	replied       bool // Reply で送れた
	quotaExceeded bool // 通数の上限で Push できなかった
}

// send は、LINE へ送る（Run の外で動く。ルームの状態には触れない）。
// tok があれば replyMsgs を Reply で送り、トークンがないか無効なら pushMsgs を Push で送る（nil なら送らない）。
func (a *Adapter) send(roomID, tok string, replyMsgs, pushMsgs []OutMessage) sendResult {
	if tok != "" {
		err := a.line.Reply(a.ctx, tok, replyMsgs)
		if err == nil {
			return sendResult{replied: true}
		}
		if ae, ok := errors.AsType[*APIError](err); !ok || !ae.InvalidReplyToken() || pushMsgs == nil {
			// 送れたかどうか分からない場合に Push すると二重に届くので、記録だけにする
			slog.Error("line: reply failed", "room", roomID, "error", err)
			return sendResult{}
		}
	}
	err := a.line.Push(a.ctx, roomID, pushMsgs)
	if err == nil {
		return sendResult{}
	}
	slog.Error("line: push failed", "room", roomID, "error", err)
	ae, ok := errors.AsType[*APIError](err)
	return sendResult{quotaExceeded: ok && ae.QuotaExceeded()}
}
