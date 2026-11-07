// Package jsonfile は、小さな JSON ファイルの読み書きをまとめる。
package jsonfile

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Read は、path の JSON を v に読む。ファイルがなければ v をそのままにして nil を返す。
func Read(path string, v any) error {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := json.Unmarshal(raw, v); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}

// WriteAtomic は、v を同じディレクトリの一時ファイルに書いてから rename する（権限は 0600）。
// 読む側（cc-connect やアダプター）が、書きかけのファイルを読むことはない。
func WriteAtomic(path string, v any) error {
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // rename 後は何もしない
	if _, err := tmp.Write(out); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
