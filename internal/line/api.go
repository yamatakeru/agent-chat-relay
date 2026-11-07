package line

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// --- Webhook ---

type webhookBody struct {
	Events []event `json:"events"`
}

type event struct {
	Type            string `json:"type"`
	Mode            string `json:"mode"`
	WebhookEventID  string `json:"webhookEventId"`
	ReplyToken      string `json:"replyToken"`
	DeliveryContext struct {
		IsRedelivery bool `json:"isRedelivery"`
	} `json:"deliveryContext"`
	Source  source   `json:"source"`
	Message *message `json:"message"`
}

type source struct {
	Type    string `json:"type"` // user / group / room
	UserID  string `json:"userId"`
	GroupID string `json:"groupId"`
	RoomID  string `json:"roomId"`
}

type message struct {
	ID      string   `json:"id"`
	Type    string   `json:"type"`
	Text    string   `json:"text"`
	Mention *mention `json:"mention"`
}

type mention struct {
	Mentionees []mentionee `json:"mentionees"`
}

type mentionee struct {
	Index  int  `json:"index"`
	Length int  `json:"length"`
	IsSelf bool `json:"isSelf"`
}

// verifySignature は、X-Line-Signature（本文の HMAC-SHA256 を Base64 にしたもの）を確かめる。
func verifySignature(secret string, body []byte, signature string) bool {
	if secret == "" || signature == "" {
		return false
	}
	want, err := base64.StdEncoding.DecodeString(signature)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hmac.Equal(mac.Sum(nil), want)
}

// --- 送信 ---

// APIError は、LINE の API がエラーを返したときの内容。
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("line: HTTP %d: %s", e.Status, e.Message) }

// QuotaExceeded は、今月の通数を使い切ったことを表すかを返す。
func (e *APIError) QuotaExceeded() bool {
	return e.Status == http.StatusTooManyRequests && strings.Contains(strings.ToLower(e.Message), "monthly limit")
}

// InvalidReplyToken は、Reply トークンの期限切れや使用済みを表すかを返す。
func (e *APIError) InvalidReplyToken() bool {
	return e.Status == http.StatusBadRequest && strings.Contains(strings.ToLower(e.Message), "invalid reply token")
}

// Client は Messaging API の送信だけを行う。
type Client struct {
	BaseURL string // 既定は https://api.line.me。テストではモックを指す
	Token   string // チャネルアクセストークン
}

type textMessage struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func toMessages(texts []string) []textMessage {
	out := make([]textMessage, len(texts))
	for i, t := range texts {
		out[i] = textMessage{Type: "text", Text: t}
	}
	return out
}

// Reply は、Reply トークンで送る（通数に数えない）。
func (c *Client) Reply(ctx context.Context, replyToken string, texts []string) error {
	return c.post(ctx, "/v2/bot/message/reply", map[string]any{"replyToken": replyToken, "messages": toMessages(texts)})
}

// Push は、ルームへ送る（グループでは人数分の通数を使う）。
func (c *Client) Push(ctx context.Context, to string, texts []string) error {
	return c.post(ctx, "/v2/bot/message/push", map[string]any{"to": to, "messages": toMessages(texts)})
}

func (c *Client) post(ctx context.Context, path string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.BaseURL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 == 2 {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	var e struct {
		Message string `json:"message"`
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_ = json.Unmarshal(raw, &e)
	return &APIError{Status: resp.StatusCode, Message: e.Message}
}
