package line

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"sync"
	"time"
)

// 受信モード（GLOSSARY.md）。
const (
	ModeMention = "mention" // Bot へのメンションがある発言だけを渡す（既定）
	ModeAll     = "all"     // すべての発言を渡す
)

// RoomIDPattern は、LINE のグループ ID（C…）と複数人トーク ID（R…）の形式。
var RoomIDPattern = regexp.MustCompile(`^[CR][0-9a-f]{32}$`)

// Room は、登録したグループの設定。
type Room struct {
	Mode string `json:"mode"`
}

type roomsFile struct {
	Rooms map[string]Room `json:"rooms"`
}

// Rooms は、登録したグループの一覧（ルームの登録）。ファイルが変わったら読み直すので、
// 登録にアダプターの再起動は要らない。グループ ID は秘密情報に準じるので、.local/ に置く。
type Rooms struct {
	Path string

	mu      sync.Mutex
	rooms   map[string]Room
	modTime time.Time
	size    int64
}

// Lookup は、登録したグループならその設定を返す。
func (r *Rooms) Lookup(id string) (Room, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.refreshLocked()
	room, ok := r.rooms[id]
	return room, ok
}

func (r *Rooms) refreshLocked() {
	info, err := os.Stat(r.Path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			slog.Error("line: stat rooms file", "error", err)
		}
		r.rooms, r.modTime, r.size = nil, time.Time{}, 0
		return
	}
	if r.rooms != nil && info.ModTime().Equal(r.modTime) && info.Size() == r.size {
		return
	}
	f, err := readRooms(r.Path)
	if err != nil {
		slog.Error("line: read rooms file", "error", err)
		return
	}
	r.rooms, r.modTime, r.size = f.Rooms, info.ModTime(), info.Size()
}

func readRooms(path string) (roomsFile, error) {
	f := roomsFile{Rooms: map[string]Room{}}
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return f, nil
	}
	if err != nil {
		return f, err
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return f, fmt.Errorf("parse %s: %w", path, err)
	}
	if f.Rooms == nil {
		f.Rooms = map[string]Room{}
	}
	return f, nil
}

// SetRoom は、グループを登録する（mode が空なら登録を外す）。登録用のコマンドから使う。
func SetRoom(path, id, mode string) error {
	if !RoomIDPattern.MatchString(id) {
		return fmt.Errorf("グループ ID の形式ではありません")
	}
	if mode != "" && mode != ModeMention && mode != ModeAll {
		return fmt.Errorf("受信モードは %s か %s です", ModeMention, ModeAll)
	}
	f, err := readRooms(path)
	if err != nil {
		return err
	}
	if mode == "" {
		delete(f.Rooms, id)
	} else {
		f.Rooms[id] = Room{Mode: mode}
	}
	out, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, out, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ListRooms は、登録したグループを ID の順に返す。
func ListRooms(path string) ([]string, map[string]Room, error) {
	f, err := readRooms(path)
	if err != nil {
		return nil, nil, err
	}
	ids := make([]string, 0, len(f.Rooms))
	for id := range f.Rooms {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, f.Rooms, nil
}
