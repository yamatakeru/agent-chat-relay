// Package workspace は、ルームごとの作業場所を cc-connect の multi-workspace モードに割り当てる（ADR 0004）。
package workspace

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"

	"github.com/yamatakeru/cc-connect-jtc-adapters/old/internal/jsonfile"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// Bindings は cc-connect の <data_dir>/workspace_bindings.json に割り当てを書く。
// cc-connect は参照のたびにこのファイルを読み直すので、再起動は要らない。
// 形式は cc-connect 1.5.0 の core/workspace_binding.go に合わせている。
type Bindings struct {
	Path     string // workspace_bindings.json
	Project  string // cc-connect の project 名
	Platform string // cc-connect の cloud_web の name
	BaseDir  string // 作業場所を作る親ディレクトリ

	mu sync.Mutex
}

// platformDir は、この platform のルームの作業場所を置くディレクトリ。
func (b *Bindings) platformDir() string { return filepath.Join(b.BaseDir, b.Platform) }

type binding struct {
	ChannelName string `json:"channel_name"`
	Workspace   string `json:"workspace"`
	BoundAt     string `json:"bound_at"`
}

// Ensure は、ルームの作業場所を作り、割り当てがなければ書き足す。cc-connect に発言を渡す前に必ず呼ぶ。
// 割り当てのないルームでは、cc-connect が git の URL を求め、送られた URL を clone してしまう。
func (b *Bindings) Ensure(roomID string) error {
	if !safeID.MatchString(b.Platform) || !safeID.MatchString(roomID) {
		return fmt.Errorf("workspace: invalid id %q:%q", b.Platform, roomID)
	}
	dir, err := filepath.Abs(filepath.Join(b.platformDir(), roomID))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}

	b.mu.Lock()
	defer b.mu.Unlock()

	// ほかの project や cc-connect が書いた割り当ては、中身を解釈せずにそのまま残す
	all := map[string]map[string]json.RawMessage{}
	if err := jsonfile.Read(b.Path, &all); err != nil {
		return err
	}
	projectKey := "project:" + b.Project
	channelKey := b.Platform + ":" + roomID
	if _, ok := all[projectKey][channelKey]; ok {
		return nil
	}
	entry, err := json.Marshal(binding{ChannelName: channelKey, Workspace: dir, BoundAt: time.Now().Format(time.RFC3339)})
	if err != nil {
		return err
	}
	if all[projectKey] == nil {
		all[projectKey] = map[string]json.RawMessage{}
	}
	all[projectKey][channelKey] = entry
	return jsonfile.WriteAtomic(b.Path, all)
}
