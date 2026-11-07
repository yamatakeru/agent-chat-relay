package line

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/yamatakeru/cc-connect-jtc-adapters/internal/cloudweb"
)

const (
	userA  = "U00000000000000000000000000000001"
	userB  = "U00000000000000000000000000000002"
	group1 = "C00000000000000000000000000000001"
	group2 = "C00000000000000000000000000000002"
)

type sent struct {
	kind  string // reply / push
	to    string // token or room
	texts []string
}

type fakeLine struct {
	sent    []sent
	pushErr error
}

func (f *fakeLine) Reply(_ context.Context, token string, texts []string) error {
	f.sent = append(f.sent, sent{"reply", token, texts})
	return nil
}

func (f *fakeLine) Push(_ context.Context, to string, texts []string) error {
	f.sent = append(f.sent, sent{"push", to, texts})
	return f.pushErr
}

type fakeCC struct {
	connected bool
	msgs      []cloudweb.Message
}

func (f *fakeCC) Send(m cloudweb.Message) error { f.msgs = append(f.msgs, m); return nil }
func (f *fakeCC) Connected() bool               { return f.connected }

type fakeBinder struct{ rooms []string }

func (f *fakeBinder) Ensure(roomID string) error {
	f.rooms = append(f.rooms, roomID)
	return nil
}

type fakeRooms map[string]Room

func (f fakeRooms) Lookup(id string) (Room, bool) { r, ok := f[id]; return r, ok }

type harness struct {
	a    *Adapter
	line *fakeLine
	cc   *fakeCC
	bind *fakeBinder
	now  time.Time
	seq  int
}

func newHarness(rooms fakeRooms) *harness {
	h := &harness{line: &fakeLine{}, cc: &fakeCC{connected: true}, bind: &fakeBinder{}, now: time.Unix(1_800_000_000, 0)}
	h.a = New(Config{ChannelSecret: "secret", AllowFrom: map[string]bool{userA: true, userB: true}, Platform: "line"},
		h.line, h.cc, h.bind, rooms)
	h.a.now = func() time.Time { return h.now }
	h.a.spawn = func(io, done func()) { io(); done() } // 送信を同期的に行う
	return h
}

func (h *harness) nextID(prefix string) string {
	h.seq++
	return fmt.Sprintf("%s%d", prefix, h.seq)
}

// groupMsg は、グループの発言イベントを作る。mentioned が真なら先頭に Bot へのメンションを付ける。
func (h *harness) groupMsg(group, user, text string, mentioned bool) event {
	ev := event{Type: "message", Mode: "active", WebhookEventID: h.nextID("ev"), ReplyToken: h.nextID("tok"),
		Source: source{Type: "group", GroupID: group, UserID: user}}
	m := &message{ID: h.nextID("m"), Type: "text", Text: text}
	if mentioned {
		m.Text = "@Bot " + text
		m.Mention = &mention{[]mentionee{{Index: 0, Length: 4, IsSelf: true}}}
	}
	ev.Message = m
	return ev
}

func (h *harness) directMsg(user, text string) event {
	return event{Type: "message", Mode: "active", WebhookEventID: h.nextID("ev"), ReplyToken: h.nextID("tok"),
		Source: source{Type: "user", UserID: user}, Message: &message{ID: h.nextID("m"), Type: "text", Text: text}}
}

func (h *harness) frame(room, content string) {
	h.a.handleFrame(cloudweb.Frame{Type: "reply", SessionKey: "line:" + room, ReplyCtx: room, Content: content})
}

// wantForwarded は、cc-connect へ渡した発言の本文が want と一致するか確かめる。
func (h *harness) wantForwarded(t *testing.T, want ...string) {
	t.Helper()
	got := make([]string, len(h.cc.msgs))
	for i, m := range h.cc.msgs {
		got[i] = m.Content
	}
	if !slices.Equal(got, want) {
		t.Fatalf("forwarded %q, want %q", got, want)
	}
}

func (h *harness) lastSent(t *testing.T) sent {
	t.Helper()
	if len(h.line.sent) == 0 {
		t.Fatal("nothing sent to LINE")
	}
	return h.line.sent[len(h.line.sent)-1]
}

const permissionPrompt = "⚠️ **権限リクエスト**\n\nエージェントが **Bash** を使用しようとしています:\n\n```\necho hi\n```\n\n**allow** / **deny** / **allow all**（このセッション中は全て自動許可）で返信してください。"

func TestWebhookSignature(t *testing.T) {
	h := newHarness(nil)
	body := `{"events":[]}`
	for _, tc := range []struct {
		sig  string
		want int
	}{{"bad", 400}, {sign("secret", body), 200}} {
		req := httptest.NewRequest(http.MethodPost, "/callback", strings.NewReader(body))
		req.Header.Set("X-Line-Signature", tc.sig)
		rec := httptest.NewRecorder()
		h.a.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("sig %q: got %d, want %d", tc.sig, rec.Code, tc.want)
		}
	}
}

func sign(secret, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestGroupForwardsOnlyMentionsFromAllowedUsersInRegisteredGroups(t *testing.T) {
	h := newHarness(fakeRooms{group1: {Mode: ModeMention}})
	h.a.handleEvent(h.groupMsg(group1, userA, "no mention", false))
	h.a.handleEvent(h.groupMsg(group1, "U99999999999999999999999999999999", "stranger", true))
	h.a.handleEvent(h.groupMsg(group2, userA, "unregistered group", true))
	h.wantForwarded(t)
	h.a.handleEvent(h.groupMsg(group1, userA, "hello", true))
	h.wantForwarded(t, "hello")
	m := h.cc.msgs[0]
	if m.Content != "hello" || m.ChatID != group1 || m.ReplyCtx != group1 || m.ChatType != "group" || !m.Mentioned || m.UserID != userA {
		t.Errorf("unexpected message: %+v", m)
	}
	if !slices.Equal(h.bind.rooms, []string{group1}) {
		t.Errorf("workspace not ensured before forwarding: %v", h.bind.rooms)
	}
}

func TestDirectMessagesNeedNoMentionOrRegistration(t *testing.T) {
	h := newHarness(nil)
	h.a.handleEvent(h.directMsg(userA, "hi"))
	if len(h.cc.msgs) != 1 || h.cc.msgs[0].ChatType != "direct" || h.cc.msgs[0].ChatID != userA {
		t.Fatalf("unexpected: %+v", h.cc.msgs)
	}
}

func TestJoinUnregisteredGroupRepliesOnce(t *testing.T) {
	h := newHarness(fakeRooms{group1: {Mode: ModeMention}})
	h.a.handleEvent(event{Type: "join", ReplyToken: "t1", Source: source{Type: "group", GroupID: group2}})
	h.a.handleEvent(event{Type: "join", ReplyToken: "t2", Source: source{Type: "group", GroupID: group1}})
	if len(h.line.sent) != 1 || h.line.sent[0].to != "t1" || h.line.sent[0].texts[0] != msgUnregistered {
		t.Fatalf("unexpected: %+v", h.line.sent)
	}
}

func TestDuplicateWebhookEventIsIgnored(t *testing.T) {
	h := newHarness(nil)
	ev := h.directMsg(userA, "hi")
	h.a.handleEvent(ev)
	h.a.handleEvent(ev)
	h.wantForwarded(t, "hi")
}

func TestApprovalWordsOnlyWhilePending(t *testing.T) {
	h := newHarness(fakeRooms{group1: {Mode: ModeMention}})
	h.a.handleEvent(h.groupMsg(group1, userA, "allow", false))
	h.a.handleEvent(h.groupMsg(group1, userA, "allow", true))
	h.wantForwarded(t)

	h.frame(group1, permissionPrompt)
	if got := h.lastSent(t).texts[0]; strings.Contains(got, "allow all") {
		t.Errorf("prompt still offers allow all: %q", got)
	}
	h.a.handleEvent(h.groupMsg(group1, userB, " 許可 ", false))
	h.wantForwarded(t, "allow")

	// 補助的な発言は出さず、承認待ちを終える
	before := len(h.line.sent)
	h.frame(group1, "✅ 許可しました。続行中...")
	if len(h.line.sent) != before {
		t.Errorf("helper message was sent to LINE")
	}
	h.a.handleEvent(h.groupMsg(group1, userA, "deny", false))
	h.wantForwarded(t, "allow")
}

func TestMentionedTextIsHeldWhilePending(t *testing.T) {
	h := newHarness(fakeRooms{group1: {Mode: ModeMention}})
	h.frame(group1, permissionPrompt)
	h.a.handleEvent(h.groupMsg(group1, userA, "ok, but explain first", true))
	h.a.handleEvent(h.groupMsg(group1, userA, "not for the bot", false))
	h.wantForwarded(t)
	h.a.handleEvent(h.groupMsg(group1, userA, "deny", false))
	h.frame(group1, "❌ 拒否しました。エージェントはこのツールの使用を中止します。")
	h.wantForwarded(t, "deny", "ok, but explain first")
}

func TestApproveAllIsBlocked(t *testing.T) {
	h := newHarness(fakeRooms{group1: {Mode: ModeMention}})
	h.frame(group1, permissionPrompt)
	h.a.handleEvent(h.groupMsg(group1, userA, "allow all", true))
	h.a.handleEvent(h.groupMsg(group1, userA, "ok, approve all please", true))
	h.wantForwarded(t)
	if got := h.lastSent(t); got.kind != "reply" || got.texts[0] != msgApproveAll {
		t.Errorf("unexpected notice: %+v", got)
	}
}

// 承認の言葉と同じく、メンションなしの「allow all」にも断りを返す。雑談には返さない
func TestUnmentionedApproveAllIsBlocked(t *testing.T) {
	h := newHarness(fakeRooms{group1: {Mode: ModeMention}})
	h.frame(group1, permissionPrompt)
	before := len(h.line.sent)
	h.a.handleEvent(h.groupMsg(group1, userA, "we should not allow all of them", false))
	if len(h.line.sent) != before {
		t.Fatalf("notice for unmentioned chat: %+v", h.line.sent[before:])
	}
	h.a.handleEvent(h.groupMsg(group1, userA, "Allow All", false))
	h.wantForwarded(t)
	if got := h.lastSent(t); got.kind != "reply" || got.texts[0] != msgApproveAll {
		t.Errorf("unexpected notice: %+v", got)
	}
	// 承認待ちでなければ反応しない
	h.frame(group1, "❌ 拒否しました。")
	before = len(h.line.sent)
	h.a.handleEvent(h.groupMsg(group1, userA, "allow all", false))
	if len(h.line.sent) != before {
		t.Errorf("notice outside pending: %+v", h.line.sent[before:])
	}
}

func TestReplyTokenReuseAndPushFallback(t *testing.T) {
	h := newHarness(fakeRooms{group1: {Mode: ModeMention}})
	ev := h.groupMsg(group1, userA, "question", true)
	h.a.handleEvent(ev)
	h.frame(group1, "answer 1")
	if got := h.lastSent(t); got.kind != "reply" || got.to != ev.ReplyToken {
		t.Errorf("first answer should use the reply token: %+v", got)
	}
	h.frame(group1, "answer 2")
	if got := h.lastSent(t); got.kind != "push" || got.to != group1 {
		t.Errorf("second answer should be pushed: %+v", got)
	}

	// 50 秒を過ぎたトークンは使わない
	h.a.handleEvent(h.groupMsg(group1, userA, "question", true))
	h.now = h.now.Add(51 * time.Second)
	h.frame(group1, "late answer")
	if got := h.lastSent(t); got.kind != "push" {
		t.Errorf("expired token was used: %+v", got)
	}
}

func TestStoppedAndRedeliveredAreNotForwarded(t *testing.T) {
	h := newHarness(nil)
	h.cc.connected = false
	h.a.handleEvent(h.directMsg(userA, "hi"))
	if got := h.lastSent(t); got.kind != "reply" || got.texts[0] != msgStopped {
		t.Errorf("unexpected: %+v", got)
	}
	h.cc.connected = true
	ev := h.directMsg(userA, "hi")
	ev.DeliveryContext.IsRedelivery = true
	h.a.handleEvent(ev)
	h.wantForwarded(t)
	if got := h.lastSent(t); got.kind != "reply" || got.texts[0] != msgRedelivered {
		t.Errorf("unexpected: %+v", got)
	}
}

func TestModeAllHoldsUnrelatedMessagesWhileWaiting(t *testing.T) {
	h := newHarness(fakeRooms{group1: {Mode: ModeAll}})
	h.a.handleEvent(h.groupMsg(group1, userA, "chat 1", false))
	h.wantForwarded(t, "chat 1")
	h.frame(group1, permissionPrompt)
	h.a.handleEvent(h.groupMsg(group1, userB, "ok", false)) // 雑談の ok を承認にしない
	h.a.handleEvent(h.groupMsg(group1, userA, "allow", false))
	h.wantForwarded(t, "chat 1", "allow")
	h.frame(group1, "✅ 許可しました。続行中...")
	h.wantForwarded(t, "chat 1", "allow", "ok")
}

func TestQuestionWaitInDirectChatForwardsAnswer(t *testing.T) {
	h := newHarness(nil)
	h.frame(userA, "**エージェントの質問**\n\nどちらにしますか？\n1. A\n2. B")
	h.a.handleEvent(h.directMsg(userA, "1"))
	h.wantForwarded(t, "1")
}

func TestDisconnectNotifiesBusyRooms(t *testing.T) {
	h := newHarness(fakeRooms{group1: {Mode: ModeMention}, group2: {Mode: ModeMention}})
	h.a.handleEvent(h.groupMsg(group1, userA, "long task", true))
	h.now = h.now.Add(time.Minute) // トークンは期限切れ
	h.a.handleEvent(h.groupMsg(group2, userA, "done task", true))
	h.frame(group2, "done")
	before := len(h.line.sent)
	h.a.handleDisconnect()
	if len(h.line.sent) != before+1 {
		t.Fatalf("want exactly one notice, got %+v", h.line.sent[before:])
	}
	if got := h.lastSent(t); got.kind != "push" || got.to != group1 || got.texts[0] != msgLost {
		t.Errorf("unexpected notice: %+v", got)
	}
}

func TestQuotaNoticeIsAddedToNextReply(t *testing.T) {
	h := newHarness(nil)
	h.line.pushErr = &APIError{Status: 429, Message: "You have reached your monthly limit."}
	h.frame(userA, "answer without token")
	h.line.pushErr = nil
	h.a.handleEvent(h.directMsg(userA, "again"))
	h.frame(userA, "answer")
	got := h.lastSent(t)
	if got.kind != "reply" || len(got.texts) != 2 || got.texts[0] != msgQuota {
		t.Errorf("quota notice not prepended: %+v", got)
	}
}

// blockingLine は、gate が閉じている間、指定した宛先への送信を止める（並行に呼ばれる）。
type blockingLine struct {
	gate  map[string]chan struct{} // 宛先（トークンかルーム）ごとの関門。作ったあとは書き換えない
	start chan string              // 送信を始めた宛先
	done  chan sent                // 送り終えたもの
}

func (f *blockingLine) wait(to string) {
	f.start <- to
	if g := f.gate[to]; g != nil {
		<-g
	}
}

func (f *blockingLine) record(kind, to string, texts []string) {
	f.done <- sent{kind, to, texts}
}

func (f *blockingLine) Reply(_ context.Context, token string, texts []string) error {
	f.wait(token)
	f.record("reply", token, texts)
	return nil
}

func (f *blockingLine) Push(_ context.Context, to string, texts []string) error {
	f.wait(to)
	f.record("push", to, texts)
	return nil
}

type syncCC struct{ msgs chan cloudweb.Message }

func (f *syncCC) Send(m cloudweb.Message) error { f.msgs <- m; return nil }
func (f *syncCC) Connected() bool               { return true }

func recv[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatal("timed out")
	}
	var zero T
	return zero
}

// LINE への送信が詰まっても、ほかのルームの処理と送信は進む。同じルームの送信は順に行う。
func TestSlowLineDoesNotBlockOtherRooms(t *testing.T) {
	ln := &blockingLine{gate: map[string]chan struct{}{group1: make(chan struct{})}, start: make(chan string, 16), done: make(chan sent, 16)}
	cc := &syncCC{msgs: make(chan cloudweb.Message, 16)}
	a := New(Config{ChannelSecret: "secret", AllowFrom: map[string]bool{userA: true}, Platform: "line"},
		ln, cc, &fakeBinder{}, fakeRooms{group1: {Mode: ModeMention}, group2: {Mode: ModeMention}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.Run(ctx)

	frame := func(room, content string) {
		a.OnFrame(cloudweb.Frame{Type: "reply", SessionKey: "line:" + room, ReplyCtx: room, Content: content})
	}
	// group1 への Push が詰まる
	frame(group1, "answer 1")
	if got := recv(t, ln.start); got != group1 {
		t.Fatalf("first send to %q", got)
	}
	frame(group1, "answer 2") // answer 1 が終わるまで送らない

	// その間も、group2 の発言は cc-connect に渡り、返事も送られる
	h := &harness{now: time.Now()}
	a.enqueue(func() { a.handleEvent(h.groupMsg(group2, userA, "hello", true)) })
	if m := recv(t, cc.msgs); m.ChatID != group2 {
		t.Fatalf("forwarded %+v", m)
	}
	frame(group2, "answer to group2")
	if got := recv(t, ln.start); got == group1 {
		t.Fatal("answer 2 was sent before answer 1 finished")
	}

	close(ln.gate[group1])
	if got := recv(t, ln.start); got != group1 {
		t.Fatalf("answer 2 sent to %q", got)
	}
	var order []string
	for range 3 {
		if s := recv(t, ln.done); s.to == group1 {
			order = append(order, s.texts[0])
		}
	}
	if !slices.Equal(order, []string{"answer 1", "answer 2"}) {
		t.Errorf("group1 order %q", order)
	}
}

func TestOutboxOverflowDrops(t *testing.T) {
	h := newHarness(nil)
	var pending []func()
	h.a.spawn = func(io, done func()) { pending = append(pending, func() { io(); done() }) }
	for i := range maxOutbox + 5 {
		h.frame(userA, fmt.Sprintf("answer %d", i))
	}
	st := h.a.state[userA]
	if len(st.outbox) != maxOutbox || !st.sending {
		t.Fatalf("outbox %d sending %v", len(st.outbox), st.sending)
	}
	for len(pending) > 0 {
		f := pending[0]
		pending = pending[1:]
		f()
	}
	if len(h.line.sent) != maxOutbox+1 {
		t.Errorf("sent %d", len(h.line.sent))
	}
}
