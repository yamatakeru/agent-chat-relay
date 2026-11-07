// Package cloudweb は、cc-connect の cloud_web platform（CWIP v1、websocket）から見た
// ゲートウェイ側を実装する。cc-connect がこのサーバーへ接続しにくる（ADR 0003）。
package cloudweb

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// cc-connect は 25 秒ごとに ping を送る。読み取りの期限はそれより十分長くする。
const readTimeout = 90 * time.Second

// ErrNotConnected は、cc-connect がつながっていないときに Send が返す。
var ErrNotConnected = errors.New("cloudweb: cc-connect is not connected")

// Message は、ゲートウェイから cc-connect へ渡す発言（CWIP の message）。
type Message struct {
	Type      string `json:"type"`
	MsgID     string `json:"msg_id"`
	ChatID    string `json:"chat_id"`
	UserID    string `json:"user_id"`
	Content   string `json:"content"`
	ReplyCtx  string `json:"reply_ctx"`
	ChatType  string `json:"chat_type"`
	Mentioned bool   `json:"mentioned"`
}

// Frame は、cc-connect から届いた 1 フレーム。テキストの機能しか宣言しないので、
// 実際に使うのは reply だけになる（カードやボタンは cc-connect がテキストに直す）。
type Frame struct {
	Type       string `json:"type"`
	SessionKey string `json:"session_key"`
	ReplyCtx   string `json:"reply_ctx"`
	Content    string `json:"content"`
}

// Server は cc-connect からの接続を 1 本だけ受け付ける。新しい接続が来たら古い接続を閉じる。
type Server struct {
	Token    string // cc-connect の cloud_web の token と同じ値
	Platform string // cc-connect の cloud_web の name（例："line"）

	OnFrame      func(Frame)
	OnDisconnect func()

	mu      sync.Mutex
	conn    *websocket.Conn
	writeMu sync.Mutex
}

var upgrader = websocket.Upgrader{}

// ServeHTTP は WebSocket の受け口。token の確認、register と register_ack、受信の繰り返しを行う。
// token は URL のクエリにも載ってくるので、リクエストの URL はログに出さない。
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		slog.Warn("cloudweb: unauthorized connection", "remote", r.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Warn("cloudweb: upgrade failed", "error", err)
		return
	}
	defer conn.Close()

	_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
	_, raw, err := conn.ReadMessage()
	if err != nil {
		slog.Warn("cloudweb: read register failed", "error", err)
		return
	}
	var reg struct {
		Type     string `json:"type"`
		Platform string `json:"platform"`
		Project  string `json:"project"`
	}
	if err := json.Unmarshal(raw, &reg); err != nil || reg.Type != "register" || reg.Platform != s.Platform {
		slog.Warn("cloudweb: unexpected register", "platform", reg.Platform, "type", reg.Type)
		_ = conn.WriteJSON(map[string]any{"type": "register_ack", "ok": false, "error": "unexpected register"})
		return
	}
	// capabilities を省略すると、cc-connect はすべての機能に対応しているものとして扱う。必ず明示する。
	if err := conn.WriteJSON(map[string]any{"type": "register_ack", "ok": true, "capabilities": []string{"text"}}); err != nil {
		return
	}
	conn.SetPingHandler(func(data string) error {
		_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		return conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(5*time.Second))
	})

	s.mu.Lock()
	if s.conn != nil {
		_ = s.conn.Close()
	}
	s.conn = conn
	s.mu.Unlock()
	slog.Info("cloudweb: cc-connect connected", "project", reg.Project)

	defer func() {
		s.mu.Lock()
		current := s.conn == conn
		if current {
			s.conn = nil
		}
		s.mu.Unlock()
		if current {
			slog.Warn("cloudweb: cc-connect disconnected")
			if s.OnDisconnect != nil {
				s.OnDisconnect()
			}
		}
	}()

	for {
		_ = conn.SetReadDeadline(time.Now().Add(readTimeout))
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}
		var f Frame
		if err := json.Unmarshal(raw, &f); err != nil {
			slog.Debug("cloudweb: invalid frame", "error", err)
			continue
		}
		if f.Type != "reply" {
			slog.Debug("cloudweb: ignored frame", "type", f.Type)
			continue
		}
		if s.OnFrame != nil {
			s.OnFrame(f)
		}
	}
}

func (s *Server) authorized(r *http.Request) bool {
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if got == "" {
		got = r.Header.Get("X-Cloud-Web-Token")
	}
	return s.Token != "" && subtle.ConstantTimeCompare([]byte(got), []byte(s.Token)) == 1
}

// Connected は、cc-connect がつながっているかを返す。
func (s *Server) Connected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn != nil
}

// Send は、発言を cc-connect へ渡す。つながっていなければ ErrNotConnected を返す。
func (s *Server) Send(m Message) error {
	s.mu.Lock()
	conn := s.conn
	s.mu.Unlock()
	if conn == nil {
		return ErrNotConnected
	}
	m.Type = "message"
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteJSON(m)
}
