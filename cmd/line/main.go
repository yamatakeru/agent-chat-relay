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
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
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
		return errors.New(usage)
	}
	switch args[0] {
	case "serve":
		return serve()
	case "room":
		return room(args[1:])
	}
	return fmt.Errorf("unknown command %q", args[0])
}

const (
	usage     = "usage: line serve | line room add|remove|list"
	roomUsage = "usage: line room add <groupId> [mention|all] | remove <groupId> | list"
)

func env(key, def string) string { return cmp.Or(os.Getenv(key), def) }

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
		return errors.New(roomUsage)
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
		rooms, err := line.ReadRooms(roomsPath())
		if err != nil {
			return err
		}
		for _, id := range slices.Sorted(maps.Keys(rooms)) {
			fmt.Printf("%s %s\n", id, rooms[id].Mode)
		}
		return nil
	}
	return errors.New(roomUsage)
}

// parseAllowFrom は、送信者の許可（カンマ区切りの userId）を読む。
// 「*」は全員許可になるため受け付けない（cc-connect の allow_from と同じ値を使う）。
func parseAllowFrom(s string) (map[string]bool, error) {
	allow := map[string]bool{}
	for id := range strings.SplitSeq(s, ",") {
		switch id = strings.TrimSpace(id); id {
		case "":
		case "*":
			return nil, errors.New("CCJ_LINE_ALLOW_FROM に「*」は使えません（全員許可になるため）")
		default:
			allow[id] = true
		}
	}
	return allow, nil
}

// retention は、受け取った添付と、LINE へ返した画像を残す期間。
const retention = 7 * 24 * time.Hour

// prune は、保存期間を過ぎた添付と公開した画像を、起動時と 1 時間ごとに消す。
func prune(ctx context.Context, bindings *workspace.Bindings, media *line.Media) {
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for {
		now := time.Now()
		if err := bindings.PruneAttachments(retention, now); err != nil {
			slog.Warn("line: prune attachments", "error", err)
		}
		if err := media.Prune(retention, now); err != nil {
			slog.Warn("line: prune media", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
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
	allow, err := parseAllowFrom(os.Getenv("CCJ_LINE_ALLOW_FROM"))
	if err != nil {
		return err
	}

	const platform = "line"
	// 受け取るのはテキストと画像。ファイルは LINE へ送れないので宣言しない（ADR 0005）
	cw := &cloudweb.Server{Token: os.Getenv("CCJ_CLOUDWEB_TOKEN"), Platform: platform, Capabilities: []string{"text", "image"}}
	client := &line.Client{
		BaseURL:     strings.TrimRight(env("CCJ_LINE_API_BASE", "https://api.line.me"), "/"),
		DataBaseURL: strings.TrimRight(env("CCJ_LINE_DATA_API_BASE", env("CCJ_LINE_API_BASE", "https://api-data.line.me")), "/"),
		Token:       os.Getenv("CCJ_LINE_CHANNEL_TOKEN"),
	}
	media := &line.Media{Dir: filepath.Join(home(), "media")}
	bindings := &workspace.Bindings{
		Path:     filepath.Join(home(), "data", "workspace_bindings.json"),
		Project:  env("CCJ_CC_PROJECT", "line"),
		Platform: platform,
		BaseDir:  filepath.Join(home(), "workspaces"),
	}
	adapter := line.New(
		line.Config{ChannelSecret: os.Getenv("CCJ_LINE_CHANNEL_SECRET"), AllowFrom: allow, Platform: platform,
			PublicURL: os.Getenv("CCJ_LINE_PUBLIC_URL")},
		client, cw, bindings, &line.Rooms{Path: roomsPath()}, media,
	)
	cw.OnFrame = adapter.OnFrame
	cw.OnDisconnect = adapter.OnDisconnect

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go adapter.Run(ctx)
	go prune(ctx, bindings, media)

	// トンネルで公開するのは、Webhook の受け口と、LINE へ返した画像だけ
	webhookMux := http.NewServeMux()
	webhookMux.Handle("/callback", adapter)
	webhookMux.Handle("GET /media/{name}", media)
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
