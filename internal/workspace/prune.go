package workspace

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/yamatakeru/cc-connect-jtc-adapters/internal/prune"
)

// PruneAttachments は、各ルームの作業場所で cc-connect が保存した添付（.cc-connect/attachments）のうち、
// 保存から maxAge を過ぎたものを消す。cc-connect 自身は消さない。
func (b *Bindings) PruneAttachments(maxAge time.Duration, now time.Time) error {
	rooms, err := os.ReadDir(b.platformDir())
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var errs []error
	for _, r := range rooms {
		if r.IsDir() {
			errs = append(errs, prune.Old(filepath.Join(b.platformDir(), r.Name(), ".cc-connect", "attachments"), maxAge, now))
		}
	}
	return errors.Join(errs...)
}
