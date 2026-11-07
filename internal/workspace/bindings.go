// Package workspace は、ルームごとの作業場所を cc-connect の multi-workspace モードに割り当てる（ADR 0004）。
package workspace

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Bindings は cc-connect の <data_dir>/workspace_bindings.json に割り当てを書く。
// cc-connect は参照のたびにこのファイルを読み直すので、再起動は要らない。
// 形式は cc-connect 1.5.0 の core/workspace_binding.go に合わせている。
type Bindings struct {
	Path    string // workspace_bindings.json
	Project string // cc-connect の project 名
	BaseDir string // 作業場所を作る親ディレクトリ

	mu sync.Mutex
}

type binding struct {
	ChannelName string `json:"channel_name"`
	Workspace   string `json:"workspace"`
	BoundAt     string `json:"bound_at"`
}

// Ensure は、platform とルームの ID に対応する作業場所を作り、割り当てがなければ書き足す。
// 作業場所のパスを返す。cc-connect に発言を渡す前に必ず呼ぶ。
// 割り当てのないルームでは、cc-connect が git の URL を求め、送られた URL を clone してしまう。
func (b *Bindings) Ensure(platform, roomID string) (string, error) {
	if !safeID.MatchString(platform) || !safeID.MatchString(roomID) {
		return "", fmt.Errorf("workspace: invalid id %q:%q", platform, roomID)
	}
	dir := filepath.Join(b.BaseDir, platform, roomID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	all := map[string]map[string]json.RawMessage{}
	raw, err := os.ReadFile(b.Path)
	switch {
	case err == nil:
		if err := json.Unmarshal(raw, &all); err != nil {
			return "", fmt.Errorf("workspace: parse %s: %w", b.Path, err)
		}
	case errors.Is(err, fs.ErrNotExist):
	default:
		return "", err
	}

	projectKey := "project:" + b.Project
	channelKey := platform + ":" + roomID
	if _, ok := all[projectKey][channelKey]; ok {
		return dir, nil
	}
	if all[projectKey] == nil {
		all[projectKey] = map[string]json.RawMessage{}
	}
	entry, err := json.Marshal(binding{ChannelName: channelKey, Workspace: dir, BoundAt: time.Now().Format(time.RFC3339)})
	if err != nil {
		return "", err
	}
	all[projectKey][channelKey] = entry

	out, err := json.MarshalIndent(all, "", "  ")
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(b.Path), 0o700); err != nil {
		return "", err
	}
	tmp := b.Path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, b.Path); err != nil {
		return "", err
	}
	return dir, nil
}
