package cloudweb

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// dial は、cc-connect の cloud_web と同じ手順で接続し、register する。
func dial(t *testing.T, url, token string) (*websocket.Conn, map[string]any) {
	t.Helper()
	h := http.Header{}
	h.Set("Authorization", "Bearer "+token)
	conn, _, err := websocket.DefaultDialer.Dial(url, h)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "register", "platform": "line", "client": "cc-connect", "project": "line", "transport": "websocket"}); err != nil {
		t.Fatal(err)
	}
	var ack map[string]any
	if err := conn.ReadJSON(&ack); err != nil {
		t.Fatal(err)
	}
	return conn, ack
}

func TestServer(t *testing.T) {
	frames := make(chan Frame, 2)
	disconnected := make(chan struct{}, 1)
	s := &Server{Token: "tok", Platform: "line", Capabilities: []string{"text", "image"},
		OnFrame:      func(f Frame) { frames <- f },
		OnDisconnect: func() { disconnected <- struct{}{} },
	}
	ts := httptest.NewServer(s)
	defer ts.Close()
	url := "ws" + strings.TrimPrefix(ts.URL, "http")

	if _, resp, err := websocket.DefaultDialer.Dial(url, http.Header{"Authorization": {"Bearer wrong"}}); err == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong token accepted: %v", err)
	}
	if err := s.Send(Message{}); err != ErrNotConnected {
		t.Fatalf("send before connect: %v", err)
	}

	conn, ack := dial(t, url, "tok")
	caps, _ := ack["capabilities"].([]any)
	if ack["ok"] != true || len(caps) != 2 || caps[0] != "text" || caps[1] != "image" {
		t.Fatalf("unexpected ack: %v", ack)
	}
	waitFor(t, s.Connected)

	img := []Attachment{{MimeType: "image/png", Data: "AAA="}}
	if err := s.Send(Message{MsgID: "m1", ChatID: "C1", UserID: "U1", Content: "hi", ReplyCtx: "C1", ChatType: "group", Mentioned: true, Images: img}); err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := conn.ReadJSON(&got); err != nil {
		t.Fatal(err)
	}
	images, _ := got["images"].([]any)
	if got["type"] != "message" || got["content"] != "hi" || got["mentioned"] != true || len(images) != 1 || got["files"] != nil {
		t.Errorf("unexpected message: %v", got)
	}

	if err := conn.WriteJSON(map[string]any{"type": "reply", "session_key": "line:C1", "reply_ctx": "C1", "content": "answer"}); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "card", "session_key": "line:C1", "reply_ctx": "C1"}); err != nil {
		t.Fatal(err)
	}
	if err := conn.WriteJSON(map[string]any{"type": "image", "session_key": "line:C1", "reply_ctx": "C1", "data": "AAA=", "mime_type": "image/png"}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"reply", "image"} { // card は渡さない
		select {
		case f := <-frames:
			if f.Type != want || f.ReplyCtx != "C1" || (want == "reply" && f.Content != "answer") || (want == "image" && f.Data != "AAA=") {
				t.Errorf("unexpected frame: %+v", f)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("no frame")
		}
	}

	conn.Close()
	select {
	case <-disconnected:
	case <-time.After(2 * time.Second):
		t.Fatal("no disconnect")
	}
	if s.Connected() {
		t.Error("still connected")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met")
}
