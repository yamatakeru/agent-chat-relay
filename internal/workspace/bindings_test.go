package workspace

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureWritesCCConnectFormat(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "data", "workspace_bindings.json")
	// cc-connect やほかの project が書いた割り当ては残す
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(`{"project:other":{"x:1":{"channel_name":"x","workspace":"/w","bound_at":""}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	b := &Bindings{Path: path, Project: "line", BaseDir: filepath.Join(dir, "ws")}

	ws, err := b.Ensure("line", "C0123")
	if err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(ws); err != nil || !info.IsDir() {
		t.Fatalf("workspace dir not created: %v", err)
	}
	if _, err := b.Ensure("line", "C0123"); err != nil {
		t.Fatal(err)
	}

	var got map[string]map[string]struct {
		ChannelName string `json:"channel_name"`
		Workspace   string `json:"workspace"`
		BoundAt     string `json:"bound_at"`
	}
	raw, _ := os.ReadFile(path)
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if _, ok := got["project:other"]["x:1"]; !ok {
		t.Error("existing binding was lost")
	}
	e, ok := got["project:line"]["line:C0123"]
	if !ok || e.Workspace != ws || e.BoundAt == "" {
		t.Errorf("unexpected binding: %+v", got["project:line"])
	}
	if len(got["project:line"]) != 1 {
		t.Errorf("duplicate bindings: %+v", got["project:line"])
	}
}

func TestEnsureRejectsUnsafeIDs(t *testing.T) {
	b := &Bindings{Path: filepath.Join(t.TempDir(), "b.json"), Project: "line", BaseDir: t.TempDir()}
	for _, id := range []string{"../etc", "a/b", ""} {
		if _, err := b.Ensure("line", id); err == nil {
			t.Errorf("accepted %q", id)
		}
	}
}
