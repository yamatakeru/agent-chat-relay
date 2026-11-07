package line

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
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
	Type    string   `json:"type"` // text / image / file など
	Text    string   `json:"text"`
	Mention *mention `json:"mention"`
	// image：line なら LINE から本体を取得できる。external は外部の URL（扱わない）
	ContentProvider *contentProvider `json:"contentProvider"`
	FileName        string           `json:"fileName"` // file
	FileSize        int64            `json:"fileSize"` // file
}

type contentProvider struct {
	Type string `json:"type"`
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

// Client は Messaging API の送信と、受け取った画像・ファイルの取得を行う。
type Client struct {
	BaseURL     string // 既定は https://api.line.me。テストではモックを指す
	DataBaseURL string // 画像やファイルの取得先。https://api-data.line.me
	Token       string // チャネルアクセストークン
}

// OutMessage は、LINE へ送る 1 つの吹き出し（テキストか画像）。
type OutMessage struct {
	Type               string `json:"type"`
	Text               string `json:"text,omitempty"`
	OriginalContentURL string `json:"originalContentUrl,omitempty"`
	PreviewImageURL    string `json:"previewImageUrl,omitempty"`
}

func textMessages(texts ...string) []OutMessage {
	out := make([]OutMessage, len(texts))
	for i, t := range texts {
		out[i] = OutMessage{Type: "text", Text: t}
	}
	return out
}

// Reply は、Reply トークンで送る（通数に数えない）。
func (c *Client) Reply(ctx context.Context, replyToken string, msgs []OutMessage) error {
	return c.post(ctx, "/v2/bot/message/reply", map[string]any{"replyToken": replyToken, "messages": msgs})
}

// Push は、ルームへ送る（グループでは人数分の通数を使う）。
func (c *Client) Push(ctx context.Context, to string, msgs []OutMessage) error {
	return c.post(ctx, "/v2/bot/message/push", map[string]any{"to": to, "messages": msgs})
}

// ErrTooLarge は、取得しようとした画像やファイルが上限より大きいときに Content が返す。
var ErrTooLarge = errors.New("line: content too large")

// Content は、利用者が送った画像やファイルの本体と MIME タイプを取得する。max バイトを超えたら ErrTooLarge を返す。
func (c *Client) Content(ctx context.Context, messageID string, max int64) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	resp, err := c.do(ctx, http.MethodGet, c.DataBaseURL+"/v2/bot/message/"+messageID+"/content", nil)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.ContentLength > max {
		return nil, "", ErrTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > max {
		return nil, "", ErrTooLarge
	}
	return data, resp.Header.Get("Content-Type"), nil
}

func (c *Client) post(ctx context.Context, path string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := c.do(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.Body.Close()
}

// do は、Messaging API を呼ぶ。2xx 以外は本文の message を APIError にして返す。
func (c *Client) do(ctx context.Context, method, url string, body io.Reader) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 == 2 {
		return resp, nil
	}
	defer resp.Body.Close()
	var e struct {
		Message string `json:"message"`
	}
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_ = json.Unmarshal(raw, &e)
	return nil, &APIError{Status: resp.StatusCode, Message: e.Message}
}
