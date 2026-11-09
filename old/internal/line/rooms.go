package line

import (
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"regexp"
	"sync"
	"time"

	"github.com/yamatakeru/cc-connect-jtc-adapters/old/internal/jsonfile"
)

// 受信モード（GLOSSARY.md）。
const (
	ModeMention = "mention" // Bot へのメンションがある発言だけを渡す（既定）
	ModeAll     = "all"     // すべての発言を渡す
)

// LINE のグループ ID（C…）と複数人トーク ID（R…）の形式。
var roomIDPattern = regexp.MustCompile(`^[CR][0-9a-f]{32}$`)

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
	rooms, err := ReadRooms(r.Path)
	if err != nil {
		slog.Error("line: read rooms file", "error", err)
		return
	}
	r.rooms, r.modTime, r.size = rooms, info.ModTime(), info.Size()
}

// ReadRooms は、登録したグループを返す。ファイルがなければ空にする。
func ReadRooms(path string) (map[string]Room, error) {
	var f roomsFile
	if err := jsonfile.Read(path, &f); err != nil {
		return nil, err
	}
	if f.Rooms == nil {
		f.Rooms = map[string]Room{}
	}
	return f.Rooms, nil
}

// SetRoom は、グループを登録する（mode が空なら登録を外す）。登録用のコマンドから使う。
func SetRoom(path, id, mode string) error {
	if !roomIDPattern.MatchString(id) {
		return fmt.Errorf("グループ ID の形式ではありません")
	}
	if mode != "" && mode != ModeMention && mode != ModeAll {
		return fmt.Errorf("受信モードは %s か %s です", ModeMention, ModeAll)
	}
	rooms, err := ReadRooms(path)
	if err != nil {
		return err
	}
	if mode == "" {
		delete(rooms, id)
	} else {
		rooms[id] = Room{Mode: mode}
	}
	return jsonfile.WriteAtomic(path, roomsFile{Rooms: rooms})
}
