package line

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func encode(t *testing.T, w, h int, noisy bool, enc func(*bytes.Buffer, image.Image) error) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	r := rand.New(rand.NewPCG(1, 2))
	for y := range h {
		for x := range w {
			c := color.RGBA{uint8(x), uint8(y), 128, 255}
			if noisy {
				c = color.RGBA{uint8(r.IntN(256)), uint8(r.IntN(256)), uint8(r.IntN(256)), 255}
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := enc(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func pngEnc(b *bytes.Buffer, m image.Image) error { return png.Encode(b, m) }

func TestPublish(t *testing.T) {
	m := &Media{Dir: filepath.Join(t.TempDir(), "media")}

	small := encode(t, 64, 48, false, func(b *bytes.Buffer, m image.Image) error { return jpeg.Encode(b, m, nil) })
	orig, preview, err := m.Publish(small)
	if err != nil || orig != preview || !mediaName.MatchString(orig) || filepath.Ext(orig) != ".jpg" {
		t.Fatalf("small: %q %q %v", orig, preview, err)
	}
	if info, err := os.Stat(filepath.Join(m.Dir, orig)); err != nil || info.Mode().Perm() != 0o600 {
		t.Errorf("saved file: %v %v", info, err)
	}

	// 1MB を超える画像には、縮小したプレビューを作る
	big := encode(t, 1200, 1000, true, pngEnc)
	if len(big) <= maxPreviewBytes {
		t.Fatalf("test image too small: %d", len(big))
	}
	orig, preview, err = m.Publish(big)
	if err != nil || orig == preview || filepath.Ext(orig) != ".png" || !mediaName.MatchString(preview) {
		t.Fatalf("big: %q %q %v", orig, preview, err)
	}
	p, err := os.ReadFile(filepath.Join(m.Dir, preview))
	if err != nil || len(p) > maxPreviewBytes {
		t.Fatalf("preview: %d %v", len(p), err)
	}
	if cfg, err := jpeg.DecodeConfig(bytes.NewReader(p)); err != nil || cfg.Width != 1024 {
		t.Errorf("preview size: %+v %v", cfg, err)
	}

	for name, data := range map[string][]byte{
		"gif":  encode(t, 8, 8, false, func(b *bytes.Buffer, m image.Image) error { return gif.Encode(b, m, nil) }),
		"text": []byte("not an image"),
	} {
		if _, _, err := m.Publish(data); !errors.Is(err, ErrUnsupportedImage) {
			t.Errorf("%s: %v", name, err)
		}
	}
}

func TestServeMedia(t *testing.T) {
	m := &Media{Dir: t.TempDir()}
	orig, _, err := m.Publish(encode(t, 8, 8, false, pngEnc))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(m.Dir, "secret.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET /media/{name}", m)
	for path, want := range map[string]int{
		"/media/" + orig:                 200,
		"/media/secret.txt":              404,
		"/media/":                        404,
		"/media/..%2Fsecret.txt":         404,
		"/media/" + orig[:10] + ".png":   404,
		"/media/" + orig[:43] + "_p.jpg": 404, // 形は合うが、ない
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != want {
			t.Errorf("%s: got %d, want %d", path, rec.Code, want)
		}
		if want == 200 && (rec.Header().Get("Content-Type") != "image/png" || rec.Header().Get("Last-Modified") != "") {
			t.Errorf("%s: headers %v", path, rec.Header())
		}
	}
}
