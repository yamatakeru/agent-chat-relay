package workspace

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// PruneOld は、dir の下（サブディレクトリを含む）で、更新から maxAge を過ぎたファイルを消し、
// 空になったサブディレクトリも消す。dir 自体は残す。dir がなければ何もしない。
func PruneOld(dir string, maxAge time.Duration, now time.Time) error {
	var dirs []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() {
			if path != dir {
				dirs = append(dirs, path)
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil // シンボリックリンクなどはたどらず、消さない
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		if now.Sub(info.ModTime()) > maxAge {
			return os.Remove(path)
		}
		return nil
	})
	// 深い順に、空のディレクトリだけを消す（空でなければ Remove は失敗するので無視する）
	for i := len(dirs) - 1; i >= 0; i-- {
		_ = os.Remove(dirs[i])
	}
	return err
}

// PruneAttachments は、各ルームの作業場所で cc-connect が保存した添付（.cc-connect/attachments）のうち、
// 保存から maxAge を過ぎたものを消す。cc-connect 自身は消さない。
func (b *Bindings) PruneAttachments(maxAge time.Duration, now time.Time) error {
	rooms, err := os.ReadDir(filepath.Join(b.BaseDir, b.Platform))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var errs []error
	for _, r := range rooms {
		if r.IsDir() {
			errs = append(errs, PruneOld(filepath.Join(b.BaseDir, b.Platform, r.Name(), ".cc-connect", "attachments"), maxAge, now))
		}
	}
	return errors.Join(errs...)
}
