package main

import (
	"context"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App 是暴露给前端的门面；具体能力分散在 pipehttp / fileops / netprobe / theme / dialogs。
type App struct {
	ctx    context.Context
	stopCh chan struct{}
	once   sync.Once
}

func NewApp() *App { return &App{stopCh: make(chan struct{})} }

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	ensureAppDirs()

	// 系统主题变化 → 通知前端
	go watchTheme(a.stopCh, func(mode string) {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "theme", map[string]any{"mode": mode})
		}
	})

	// clash-verge.yaml 被 Verge 重写 → 通知前端补一次端口
	go a.watchClashConfig()
}

func (a *App) shutdown(_ context.Context) {
	a.once.Do(func() { close(a.stopCh) })
}

// watchClashConfig 只盯着配置文件的时间戳变化（事件驱动，不做定时轮询界面）。
func (a *App) watchClashConfig() {
	path := clashConfigPath()
	last := modifiedOf(path)
	ticker := time.NewTicker(1800 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-a.stopCh:
			return
		case <-ticker.C:
			now := modifiedOf(path)
			if now == last {
				continue
			}
			last = now
			if a.ctx != nil {
				runtime.EventsEmit(a.ctx, "config.changed", map[string]any{"path": path})
			}
		}
	}
}
