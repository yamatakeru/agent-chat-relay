package workspace

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPruneAttachments(t *testing.T) {
	base := t.TempDir()
	now := time.Now()
	old := now.Add(-8 * 24 * time.Hour)
	att := filepath.Join(base, "line", "C1", ".cc-connect", "attachments")
	files := map[string]time.Time{
		filepath.Join(att, "img_old.jpg"):         old,
		filepath.Join(att, "img_new.jpg"):         now,
		filepath.Join(att, "m1", "report.pdf"):    old, // ファイルはメッセージごとのディレクトリに入る
		filepath.Join(att, "m2", "notes.txt"):     now,
		filepath.Join(base, "line", "C1", "keep"): old, // 作業場所のほかのファイルは消さない
	}
	for p, mt := range files {
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(p, mt, mt); err != nil {
			t.Fatal(err)
		}
	}
	b := &Bindings{Platform: "line", BaseDir: base}
	if err := b.PruneAttachments(7*24*time.Hour, now); err != nil {
		t.Fatal(err)
	}
	for p, mt := range files {
		_, err := os.Stat(p)
		gone := os.IsNotExist(err)
		wantGone := mt.Equal(old) && filepath.Base(p) != "keep"
		if gone != wantGone {
			t.Errorf("%s: gone=%v want %v", p, gone, wantGone)
		}
	}
	if _, err := os.Stat(filepath.Join(att, "m1")); !os.IsNotExist(err) {
		t.Error("empty directory was not removed")
	}
	if _, err := os.Stat(att); err != nil {
		t.Error("attachments directory itself was removed")
	}
	// ルームがまだないときも失敗しない
	if err := (&Bindings{Platform: "line", BaseDir: filepath.Join(base, "none")}).PruneAttachments(time.Hour, now); err != nil {
		t.Error(err)
	}
}
