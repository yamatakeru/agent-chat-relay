package line

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"image"
	"image/jpeg"
	_ "image/png" // PNG を読めるようにする
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"time"

	"golang.org/x/image/draw"

	"github.com/yamatakeru/cc-connect-jtc-adapters/old/internal/prune"
)

// LINE の画像メッセージの条件（JPEG・PNG、本体は 10MB、プレビューは 1MB まで）。
const (
	maxImageBytes   = 10 << 20
	maxPreviewBytes = 1 << 20
	// 読み込む画素数の上限（巨大な画像でメモリを使い切らないため）。
	maxImagePixels = 50_000_000
)

// 送れる画像の MIME タイプと拡張子。
var imageExt = map[string]string{"image/jpeg": ".jpg", "image/png": ".png"}

// ErrUnsupportedImage は、LINE に送れない画像（形式・大きさ）のときに Publish が返す。
var ErrUnsupportedImage = errors.New("line: unsupported image")

// 公開する名前：256 ビットの乱数（Base64URL で 43 文字）と、プレビューなら _p、拡張子。
var mediaName = regexp.MustCompile(`^[A-Za-z0-9_-]{43}(_p)?\.(jpg|png)$`)

// Media は、Claude が返した画像を LINE へ渡すために公開する（ADR 0005）。
// LINE は画像を保存せず、開かれるたびに URL から取得するので、URL は保存期間の間ずっと有効にしておく。
// URL を知っていれば誰でも見られるが、推測できない名前にし、一覧は出さない。URL はログに出さない。
type Media struct {
	Dir string // .local/line/media
}

// Publish は、画像を保存し、本体とプレビューのファイル名を返す。
func (m *Media) Publish(data []byte) (orig, preview string, err error) {
	ext, ok := imageExt[http.DetectContentType(data)]
	if !ok || len(data) > maxImageBytes {
		return "", "", ErrUnsupportedImage
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width*cfg.Height > maxImagePixels {
		return "", "", ErrUnsupportedImage
	}

	id := make([]byte, 32)
	if _, err := rand.Read(id); err != nil {
		return "", "", err
	}
	name := base64.RawURLEncoding.EncodeToString(id)
	if err := os.MkdirAll(m.Dir, 0o700); err != nil {
		return "", "", err
	}
	orig = name + ext
	if err := os.WriteFile(filepath.Join(m.Dir, orig), data, 0o600); err != nil {
		return "", "", err
	}
	if len(data) <= maxPreviewBytes {
		return orig, orig, nil
	}
	small, err := shrink(data)
	if err != nil {
		return "", "", err
	}
	preview = name + "_p.jpg"
	if err := os.WriteFile(filepath.Join(m.Dir, preview), small, 0o600); err != nil {
		return "", "", err
	}
	return orig, preview, nil
}

// shrink は、1MB 以下の JPEG の縮小版を作る。
func shrink(data []byte) ([]byte, error) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, ErrUnsupportedImage
	}
	for _, side := range []int{1024, 512, 240} {
		b := src.Bounds()
		w, h := b.Dx(), b.Dy()
		if w > side || h > side {
			if w >= h {
				w, h = side, max(1, h*side/w)
			} else {
				w, h = max(1, w*side/h), side
			}
		}
		dst := image.NewRGBA(image.Rect(0, 0, w, h))
		draw.ApproxBiLinear.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 80}); err != nil {
			return nil, err
		}
		if buf.Len() <= maxPreviewBytes {
			return buf.Bytes(), nil
		}
	}
	return nil, ErrUnsupportedImage
}

// Prune は、公開から maxAge を過ぎた画像を消す。消した画像は LINE で開けなくなる。
func (m *Media) Prune(maxAge time.Duration, now time.Time) error {
	return prune.Old(m.Dir, maxAge, now)
}

// ServeHTTP は、公開した画像を返す（GET /media/{name} に登録する）。名前の形に合わないものは 404 にする。
func (m *Media) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !mediaName.MatchString(name) {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(m.Dir, name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	h := w.Header()
	h.Set("Content-Type", mime.TypeByExtension(filepath.Ext(name)))
	h.Set("Cache-Control", "private, max-age=604800")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Robots-Tag", "noindex")
	h.Set("Referrer-Policy", "no-referrer")
	http.ServeContent(w, r, "", time.Time{}, f) // 更新日時は出さない
}
