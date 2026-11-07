package line

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestContent(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v2/bot/message/1/content":
			w.Header().Set("Content-Type", "image/jpeg")
			_, _ = w.Write([]byte("12345"))
		case "/v2/bot/message/2/content": // 大きさを前もって伝えない
			w.(http.Flusher).Flush()
			_, _ = w.Write([]byte(strings.Repeat("x", 100)))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer ts.Close()
	c := &Client{DataBaseURL: ts.URL, Token: "tok"}
	ctx := context.Background()

	data, mime, err := c.Content(ctx, "1", 5)
	if err != nil || string(data) != "12345" || mime != "image/jpeg" {
		t.Errorf("got %q %q %v", data, mime, err)
	}
	if _, _, err := c.Content(ctx, "1", 4); !errors.Is(err, ErrTooLarge) {
		t.Errorf("content-length over max: %v", err)
	}
	if _, _, err := c.Content(ctx, "2", 99); !errors.Is(err, ErrTooLarge) {
		t.Errorf("body over max: %v", err)
	}
	var ae *APIError
	if _, _, err := c.Content(ctx, "3", 99); !errors.As(err, &ae) || ae.Status != 404 {
		t.Errorf("not found: %v", err)
	}
}
