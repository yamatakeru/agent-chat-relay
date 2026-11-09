package line

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRoomsReloadWithoutRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rooms.json")
	r := &Rooms{Path: path}
	if _, ok := r.Lookup(group1); ok {
		t.Fatal("found a room before registration")
	}
	if err := SetRoom(path, group1, ModeAll); err != nil {
		t.Fatal(err)
	}
	if room, ok := r.Lookup(group1); !ok || room.Mode != ModeAll {
		t.Fatalf("got %+v %v", room, ok)
	}
	if err := SetRoom(path, group2, ModeMention); err != nil {
		t.Fatal(err)
	}
	// 同じ秒の中で書き換えても、大きさが変われば読み直す
	if _, ok := r.Lookup(group2); !ok {
		t.Fatal("second registration not picked up")
	}
	if err := SetRoom(path, group1, ""); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Second)
	_ = os.Chtimes(path, future, future)
	if _, ok := r.Lookup(group1); ok {
		t.Fatal("removed room still found")
	}
}

func TestSetRoomValidates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rooms.json")
	if err := SetRoom(path, "not-an-id", ModeMention); err == nil {
		t.Error("invalid id accepted")
	}
	if err := SetRoom(path, group1, "loud"); err == nil {
		t.Error("invalid mode accepted")
	}
}
