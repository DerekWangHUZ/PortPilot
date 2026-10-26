package main

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/registry"
)

// 启动前的自检：把「双击没反应」变成一句能看懂的话。
// Wails 在 WebView2 初始化失败时会走它自己的致命路径，不一定经过我们的错误处理，
// 所以这两件最常见的失败原因必须在调用 wails.Run 之前先查，并且能自动绕开。

func webviewDataDir() string {
	return filepath.Join(roamingDir(), appName+".exe")
}

// webviewFallbackDirs 备用数据目录：主目录不可用时依次尝试。
// 受限令牌（安全警告的"运行"路径、安全软件的"受限运行"）写不进用户配置目录，
// 连 %TEMP% 都可能被拒，但 exe 同目录通常是可写的——所以最后兜到便携模式。
func webviewFallbackDirs() []string {
	dirs := []string{}
	if d := localAppDataDir(); d != "" {
		dirs = append(dirs, filepath.Join(d, appName, "webview"))
	}
	if t := os.TempDir(); t != "" {
		dirs = append(dirs, filepath.Join(t, appName, "webview"))
	}
	if d := exeDir(); d != "" {
		dirs = append(dirs, filepath.Join(d, ".portpilot-webview"))
	}
	return dirs
}

func webView2Installed() bool {
	roots := []string{
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "Microsoft", "EdgeWebView", "Application"),
		filepath.Join(os.Getenv("ProgramFiles"), "Microsoft", "EdgeWebView", "Application"),
		filepath.Join(localAppDataDir(), "Microsoft", "EdgeWebView", "Application"),
	}
	for _, root := range roots {
		if root == "" {
			continue
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			if _, err := os.Stat(filepath.Join(root, e.Name(), "msedgewebview2.exe")); err == nil {
				return true
			}
		}
	}

	// 注册表兜底：WebView2 运行时固定在下面这个 CLSID 下
	for _, key := range []string{
		`SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
		`SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`,
	} {
		k, err := registry.OpenKey(registry.LOCAL_MACHINE, key, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		pv, _, err := k.GetStringValue("pv")
		_ = k.Close()
		if err == nil && pv != "" {
			return true
		}
	}
	return false
}

// ensureWritableDir 确保目录存在且可写；同名文件挡路时先把它挪开。
func ensureWritableDir(dir string) error {
	if st, err := os.Stat(dir); err == nil && !st.IsDir() {
		if renameErr := os.Rename(dir, dir+".blocked"); renameErr != nil {
			return errors.New("同名文件挡住了数据目录且无法移动：" + renameErr.Error())
		}
		logLine("把挡路的同名文件挪开：" + dir + " -> " + dir + ".blocked")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	probe := filepath.Join(dir, ".portpilot-write-test")
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return err
	}
	_ = os.Remove(probe)
	return nil
}

// preflight 返回实际可用的 WebView2 数据目录。
// 主目录不可用时自动退到备用目录，避免目录被占用或不可写时无法启动。
func preflight() (string, error) {
	if !webView2Installed() {
		return "", errors.New("没有找到 Microsoft Edge WebView2 运行时。\n" +
			"请安装后重试：https://developer.microsoft.com/microsoft-edge/webview2/")
	}

	candidates := append([]string{webviewDataDir()}, webviewFallbackDirs()...)
	var firstErr error
	for i, dir := range candidates {
		if err := ensureWritableDir(dir); err != nil {
			if firstErr == nil {
				firstErr = errors.New("WebView2 数据目录不可用：" + dir + "\n" + err.Error() +
					"\n\n请检查目录权限，或把该目录删除后重试。")
			}
			logLine("数据目录不可用：" + dir + " -> " + err.Error())
			continue
		}
		if i > 0 {
			logLine("主数据目录不可用，改用备用目录：" + dir)
		}
		return dir, nil
	}
	return "", firstErr
}
