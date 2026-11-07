// Package line は、LINE と cc-connect（cloud_web）の間をつなぐアダプター。
// 振る舞いの仕様は docs/line-adapter.md にある。
package line

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/yamatakeru/cc-connect-jtc-adapters/internal/cloudweb"
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
)

const (
	// Reply トークンは受信から 1 分以内に 1 回だけ使える。余裕を見て 50 秒までにする。
	replyTokenTTL = 50 * time.Second
	// LINE の再送に備え、webhookEventId を覚えておく期間。
	seenTTL = 24 * time.Hour
)

// Sender は、cc-connect へ発言を渡す口（cloudweb.Server）。
type Sender interface {
	Send(cloudweb.Message) error
	Connected() bool
}

// Binder は、ルームの作業場所を割り当てる口（workspace.Bindings）。
type Binder interface {
	Ensure(platform, roomID string) (string, error)
}

// Messenger は、LINE へ送る口（Client）。
type Messenger interface {
	Reply(ctx context.Context, replyToken string, texts []string) error
	Push(ctx context.Context, to string, texts []string) error
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

type roomState struct {
	tokens []replyToken       // 未使用の Reply トークン
	wait   waitKind           // 承認待ち・回答待ち
	held   []cloudweb.Message // 待ちの間に保留した発言（受信モードが「すべて」のとき）
	busy   bool               // 渡した依頼の返事をまだ受け取っていない
	quota  bool               // 通数の上限で Push できなかった（次の Reply で伝える）
}

// Adapter は、すべての処理を 1 つのゴルーチンで順に行う（ルームの状態に鍵をかけないため）。
type Adapter struct {
	cfg   Config
	line  Messenger
	cc    Sender
	bind  Binder
	rooms RoomLookup
	now   func() time.Time

	events chan func()
	state  map[string]*roomState
	seen   map[string]time.Time
}

// New は Adapter を作る。Run を別のゴルーチンで動かしてから使う。
func New(cfg Config, line Messenger, cc Sender, bind Binder, rooms RoomLookup) *Adapter {
	return &Adapter{
		cfg: cfg, line: line, cc: cc, bind: bind, rooms: rooms, now: time.Now,
		events: make(chan func(), 256),
		state:  map[string]*roomState{},
		seen:   map[string]time.Time{},
	}
}

// Run は、ctx が終わるまで処理を順に実行する。
func (a *Adapter) Run(ctx context.Context) {
	for {
		select {
		case f := <-a.events:
			f()
		case <-ctx.Done():
			return
		}
	}
}

func (a *Adapter) enqueue(f func()) { a.events <- f }

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
	for _, ev := range wb.Events {
		a.enqueue(func() { a.handleEvent(ev) })
	}
	w.WriteHeader(http.StatusOK)
}

func (a *Adapter) room(id string) *roomState {
	st := a.state[id]
	if st == nil {
		st = &roomState{}
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
		for k, t := range a.seen {
			if now.Sub(t) > seenTTL {
				delete(a.seen, k)
			}
		}
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
			a.replyOnly(ev.ReplyToken, msgUnregistered)
		}
		return
	}
	if ev.Type != "message" || ev.Message == nil || ev.Message.Type != "text" {
		return
	}

	// 送信者の許可とルームの登録。userId と groupId は登録のためにログへ出す（ログは .local/ にだけ残す）
	user := ev.Source.UserID
	if !a.cfg.AllowFrom[user] {
		slog.Info("line: message from unauthorized user", "user", user, "room", roomID)
		return
	}
	mode := ModeMention
	if chatType == "group" {
		room, ok := a.rooms.Lookup(roomID)
		if !ok {
			slog.Info("line: message in unregistered group", "group", roomID)
			return
		}
		if room.Mode == ModeAll {
			mode = ModeAll
		}
	}

	st := a.room(roomID)
	if ev.ReplyToken != "" {
		st.tokens = append(st.tokens, replyToken{token: ev.ReplyToken, at: a.now()})
	}

	text := ev.Message.Text
	mentioned := chatType == "direct" // 1 対 1 トークの発言は、すべて Bot あて
	if ev.Message.Mention != nil {
		for _, m := range ev.Message.Mention.Mentionees {
			mentioned = mentioned || m.IsSelf
		}
		text = stripSelfMentions(text, ev.Message.Mention.Mentionees)
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
		hold = mentioned || mode == ModeAll
	case st.wait == waitQuestion:
		forward, hold = mentioned, !mentioned && mode == ModeAll
	default:
		forward = mentioned || mode == ModeAll
	}

	msg := cloudweb.Message{
		MsgID: ev.Message.ID, ChatID: roomID, UserID: user, Content: text,
		ReplyCtx: roomID, ChatType: chatType, Mentioned: true,
	}
	switch {
	case !forward && !hold:
		return
	case isApproveAll(text):
		// cc-connect は承認待ちの間に allow all を受け取ると、以降の承認をすべて省く
		a.notify(st, msgApproveAll)
		return
	case ev.DeliveryContext.IsRedelivery:
		// アダプターが止まっている間に届き、あとで再送された依頼は実行しない
		a.notify(st, msgRedelivered)
		return
	case hold:
		st.held = append(st.held, msg)
		return
	}
	a.forward(roomID, st, msg, !isApproval)
}

// forward は、割り当てを確かめてから cc-connect へ発言を渡す。
func (a *Adapter) forward(roomID string, st *roomState, msg cloudweb.Message, request bool) {
	if !a.cc.Connected() {
		a.notify(st, msgStopped)
		return
	}
	if _, err := a.bind.Ensure(a.cfg.Platform, roomID); err != nil {
		slog.Error("line: ensure workspace", "error", err)
		a.notify(st, msgInternal)
		return
	}
	if err := a.cc.Send(msg); err != nil {
		slog.Warn("line: send to cc-connect", "error", err)
		a.notify(st, msgStopped)
		return
	}
	if request {
		st.busy = true
	}
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
	switch classify(f.Content) {
	case kindPermissionPrompt:
		st.wait = waitPermission
		a.deliver(roomID, st, withoutAllowAll(f.Content))
	case kindPermissionHint:
		a.deliver(roomID, st, withoutAllowAll(f.Content))
	case kindQuestion:
		st.wait = waitQuestion
		a.deliver(roomID, st, f.Content)
	case kindHelper:
		// 「✅ 許可しました」などは出さない。承認待ちはここで終わる
		st.wait = waitNone
		a.flush(roomID, st)
	default:
		st.wait, st.busy = waitNone, false
		a.deliver(roomID, st, f.Content)
		a.flush(roomID, st)
	}
}

// flush は、待ちの間に保留した発言を順に渡す。
func (a *Adapter) flush(roomID string, st *roomState) {
	held := st.held
	st.held = nil
	for _, m := range held {
		a.forward(roomID, st, m, true)
	}
}

func (a *Adapter) handleDisconnect() {
	for id, st := range a.state {
		if st.busy || st.wait != waitNone || len(st.held) > 0 {
			a.deliver(id, st, msgLost)
		}
		st.busy, st.wait, st.held = false, waitNone, nil
	}
}

// takeToken は、未使用で新しい Reply トークンを 1 つ取り出す。
func (st *roomState) takeToken(now time.Time) (string, bool) {
	fresh := st.tokens[:0]
	for _, t := range st.tokens {
		if now.Sub(t.at) < replyTokenTTL {
			fresh = append(fresh, t)
		}
	}
	st.tokens = fresh
	if len(fresh) == 0 {
		return "", false
	}
	t := fresh[len(fresh)-1]
	st.tokens = fresh[:len(fresh)-1]
	return t.token, true
}

// deliver は、使える Reply トークンがあれば Reply、なければ Push で送る。
func (a *Adapter) deliver(roomID string, st *roomState, text string) {
	bubbles := splitBubbles(text)
	if len(bubbles) == 0 {
		return
	}
	ctx := context.Background()
	if tok, ok := st.takeToken(a.now()); ok {
		withNotice := bubbles
		if st.quota && len(bubbles) < maxBubbles {
			withNotice = append([]string{msgQuota}, bubbles...)
		}
		err := a.line.Reply(ctx, tok, withNotice)
		if err == nil {
			st.quota = false
		}
		var ae *APIError
		if err == nil {
			return
		}
		if !errors.As(err, &ae) || !ae.InvalidReplyToken() {
			// 送れたかどうか分からない場合に Push すると二重に届くので、記録だけにする
			slog.Error("line: reply failed", "room", roomID, "error", err)
			return
		}
	}
	err := a.line.Push(ctx, roomID, bubbles)
	if err == nil {
		return
	}
	slog.Error("line: push failed", "room", roomID, "error", err)
	var ae *APIError
	if errors.As(err, &ae) && ae.QuotaExceeded() {
		// このときは使える Reply トークンがない。次に Reply で送るときに書き添える
		st.quota = true
	}
}

// notify は、案内を Reply でだけ返す（通数を使わない）。使えるトークンがなければ記録だけにする。
func (a *Adapter) notify(st *roomState, text string) {
	tok, ok := st.takeToken(a.now())
	if !ok {
		slog.Info("line: notice not sent (no reply token)", "notice", text)
		return
	}
	a.replyOnly(tok, text)
}

func (a *Adapter) replyOnly(token, text string) {
	if token == "" {
		return
	}
	if err := a.line.Reply(context.Background(), token, []string{text}); err != nil {
		slog.Warn("line: reply failed", "error", err)
	}
}
