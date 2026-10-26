package main

import (
	"embed"
	"io/fs"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

// 界面用 go:embed 编进二进制，产物天然是单个 exe。
// 界面目录里额外带上 shared（构建脚本把 src/shared/*.js 复制进 src/web/shared/）。
//
//go:embed all:src/web
var webAssets embed.FS

func main() {
	// 没有控制台，panic 也必须变成可见的错误
	defer func() {
		if r := recover(); r != nil {
			reportStartupFailure("启动时发生崩溃", r)
			os.Exit(1)
		}
	}()

	for _, arg := range os.Args[1:] {
		if arg == "--selftest" {
			os.Exit(runSelfTest())
		}
	}

	logStartupBanner()

	// 先查最容易导致"双击没反应"的两件事：WebView2 运行时、数据目录可写性；
	// 主目录不可用时自动退到备用目录。
	dataDir, pfErr := preflight()
	if pfErr != nil {
		reportStartupFailure("启动前检查未通过", pfErr)
		os.Exit(1)
	}

	assets, err := fs.Sub(webAssets, "src/web")
	if err != nil {
		reportStartupFailure("界面资源不可用", err)
		os.Exit(1)
	}

	app := NewApp()

	background := &options.RGBA{R: 245, G: 245, B: 247, A: 1}
	if !themeIsLight() {
		background = &options.RGBA{R: 28, G: 28, B: 30, A: 1}
	}

	if err := wails.Run(&options.App{
		Title:            appName,
		Width:            1460,
		Height:           940,
		MinWidth:         820,
		MinHeight:        540,
		Frameless:        true,
		DisableResize:    false,
		BackgroundColour: background,
		AssetServer:      &assetserver.Options{Assets: assets},
		OnStartup:        app.startup,
		OnShutdown:       app.shutdown,
		Bind:             []interface{}{app},
		Logger:           fileLogger{},
		Windows: &windows.Options{
			WebviewIsTransparent:              false,
			WindowIsTranslucent:               false,
			DisableWindowIcon:                 false,
			ZoomFactor:                        1,
			IsZoomControlEnabled:              false,
			DisableFramelessWindowDecorations: false,
			// 用 preflight 选定的目录，避免两处各算一个路径
			WebviewUserDataPath: dataDir,
			// Wails 自带提示框改成中文，免得用户看到一句英文不知所措
			Messages: &windows.Messages{
				InstallationRequired: "需要 Microsoft Edge WebView2 运行时，确定后将静默下载安装，请稍候。",
				UpdateRequired:       "Microsoft Edge WebView2 运行时需要更新，确定后将静默下载安装，请稍候。",
				MissingRequirements:  "缺少运行环境",
				Webview2NotInstalled: "没有安装 WebView2 运行时",
				Error:                "PortPilot 启动失败",
				FailedToInstall:      "运行时安装失败，请重试。",
				DownloadPage:         "PortPilot 需要 WebView2 运行时。按确定打开下载页。最低版本：",
				PressOKToInstall:     "按确定开始安装。",
				ContactAdmin:         "PortPilot 需要 WebView2 运行时，请联系系统管理员安装。",
				InvalidFixedWebview2: "指定的 WebView2 运行时无效，请检查版本与路径。",
				WebView2ProcessCrash: "WebView2 进程崩溃，请重启 PortPilot。",
			},
		},
	}); err != nil {
		reportStartupFailure("Wails 启动失败", err)
		os.Exit(1)
	}

	logLine("=== 正常退出 ===")
}
