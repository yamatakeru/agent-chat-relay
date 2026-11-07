// line は、LINE と cc-connect（cloud_web）をつなぐアダプター。
//
//	line serve                      アダプターを動かす
//	line room add <groupId> [mode]  グループを登録する（mode は mention か all。既定は mention）
//	line room remove <groupId>      グループの登録を外す
//	line room list                  登録したグループを表示する
//
// 設定はすべて環境変数から読む（scripts/line.sh が dotenvx で注入する）。
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/yamatakeru/cc-connect-jtc-adapters/internal/cloudweb"
	"github.com/yamatakeru/cc-connect-jtc-adapters/internal/line"
	"github.com/yamatakeru/cc-connect-jtc-adapters/internal/workspace"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: line serve | line room add|remove|list")
	}
	switch args[0] {
	case "serve":
		return serve()
	case "room":
		return room(args[1:])
	}
	return fmt.Errorf("unknown command %q", args[0])
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func requireEnv(keys ...string) error {
	var missing []string
	for _, k := range keys {
		if os.Getenv(k) == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("環境変数が設定されていません: %s", strings.Join(missing, ", "))
	}
	return nil
}

func home() string { return env("CCJ_LINE_HOME", ".local/line") }

func roomsPath() string { return filepath.Join(home(), "rooms.json") }

func room(args []string) error {
	if len(args) == 0 {
		return errors.New("usage: line room add <groupId> [mention|all] | remove <groupId> | list")
	}
	switch {
	case args[0] == "add" && (len(args) == 2 || len(args) == 3):
		mode := line.ModeMention
		if len(args) == 3 {
			mode = args[2]
		}
		return line.SetRoom(roomsPath(), args[1], mode)
	case args[0] == "remove" && len(args) == 2:
		return line.SetRoom(roomsPath(), args[1], "")
	case args[0] == "list" && len(args) == 1:
		ids, rooms, err := line.ListRooms(roomsPath())
		if err != nil {
			return err
		}
		for _, id := range ids {
			fmt.Printf("%s %s\n", id, rooms[id].Mode)
		}
		return nil
	}
	return errors.New("usage: line room add <groupId> [mention|all] | remove <groupId> | list")
}

func serve() error {
	level := slog.LevelInfo
	if env("CCJ_LOG_LEVEL", "info") == "debug" {
		level = slog.LevelDebug
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level})))

	if err := requireEnv("CCJ_LINE_CHANNEL_SECRET", "CCJ_LINE_CHANNEL_TOKEN", "CCJ_LINE_ALLOW_FROM", "CCJ_CLOUDWEB_TOKEN"); err != nil {
		return err
	}
	allow := map[string]bool{}
	for _, id := range strings.Split(os.Getenv("CCJ_LINE_ALLOW_FROM"), ",") {
		if id = strings.TrimSpace(id); id != "" && id != "*" {
			allow[id] = true
		}
	}

	const platform = "line"
	cw := &cloudweb.Server{Token: os.Getenv("CCJ_CLOUDWEB_TOKEN"), Platform: platform}
	client := &line.Client{
		BaseURL: env("CCJ_LINE_API_BASE", "https://api.line.me"),
		Token:   os.Getenv("CCJ_LINE_CHANNEL_TOKEN"),
		HTTP:    &http.Client{Timeout: 20 * time.Second},
	}
	bindings := &workspace.Bindings{
		Path:    filepath.Join(home(), "data", "workspace_bindings.json"),
		Project: env("CCJ_CC_PROJECT", "line"),
		BaseDir: filepath.Join(home(), "workspaces"),
	}
	if abs, err := filepath.Abs(bindings.BaseDir); err == nil {
		bindings.BaseDir = abs
	}
	adapter := line.New(
		line.Config{ChannelSecret: os.Getenv("CCJ_LINE_CHANNEL_SECRET"), AllowFrom: allow, Platform: platform},
		client, cw, bindings, &line.Rooms{Path: roomsPath()},
	)
	cw.OnFrame = adapter.OnFrame
	cw.OnDisconnect = adapter.OnDisconnect

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go adapter.Run(ctx)

	webhookMux := http.NewServeMux()
	webhookMux.Handle("/callback", adapter)
	cwMux := http.NewServeMux()
	cwMux.Handle("/cloud-web/ws", cw)

	servers := []*http.Server{
		{Addr: env("CCJ_LINE_WEBHOOK_ADDR", "127.0.0.1:18080"), Handler: webhookMux, ReadHeaderTimeout: 10 * time.Second},
		{Addr: env("CCJ_CLOUDWEB_ADDR", "127.0.0.1:18090"), Handler: cwMux, ReadHeaderTimeout: 10 * time.Second},
	}
	errc := make(chan error, len(servers))
	for _, s := range servers {
		ln, err := net.Listen("tcp", s.Addr)
		if err != nil {
			return err
		}
		slog.Info("line: listening", "addr", s.Addr)
		go func() { errc <- s.Serve(ln) }()
	}

	select {
	case <-ctx.Done():
	case err := <-errc:
		return err
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(shutdownCtx)
	}
	return nil
}
