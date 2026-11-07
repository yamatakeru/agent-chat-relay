// Package prune は、保存期間を過ぎたファイルを消す。
package prune

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// Old は、dir の下（サブディレクトリを含む）で、更新から maxAge を過ぎたファイルを消し、
// 空になったサブディレクトリも消す。dir 自体は残す。dir がなければ何もしない。
func Old(dir string, maxAge time.Duration, now time.Time) error {
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
