package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// 日志与错误上报。
// exe 是 windowsgui 子系统、没有控制台，所以启动失败必须"落盘 + 弹框"，
// 否则用户只会看到「双击了没反应」——那是最难查的一种失败。

var (
	logMu           sync.Mutex
	procMessageBoxW = user32.NewProc("MessageBoxW")
)

func logFilePath() string {
	if d := appDataDir(); d != "" {
		return filepath.Join(d, "portpilot.log")
	}
	return filepath.Join(os.TempDir(), "PortPilot.log")
}

// logSinks 依次尝试多处落盘：只要有一处可写，启动过程就留得下证据。
// （受限环境下 %APPDATA% 可能被拒绝，此时 exe 同目录往往仍然可写。）
func logSinks() []string {
	var paths []string
	if p := logFilePath(); p != "" {
		paths = append(paths, p)
	}
	if d := localAppDataDir(); d != "" {
		paths = append(paths, filepath.Join(d, appName, "portpilot.log"))
	}
	if d := exeDir(); d != "" {
		paths = append(paths, filepath.Join(d, "portpilot-startup.log"))
	}
	if t := os.TempDir(); t != "" {
		paths = append(paths, filepath.Join(t, "PortPilot.log"))
	}
	return paths
}

func logLine(text string) {
	logMu.Lock()
	defer logMu.Unlock()
	line := "[" + time.Now().Format("2006-01-02 15:04:05") + "] " +
		strings.TrimRight(text, "\r\n") + "\r\n"
	// 第一处写成功就够：正常情况下日志只落在 %APPDATA%，不会在 exe 旁边丢文件；
	// 受限环境下前面几处都写不进去，才会兜到 exe 同目录。
	for _, path := range logSinks() {
		if appendLine(path, line) {
			return
		}
	}
}

func appendLine(path, line string) bool {
	if path == "" {
		return false
	}
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return false
	}
	defer f.Close()
	_, err = f.WriteString(line)
	return err == nil
}

// fileLogger 满足 wails 的 logger.Logger，把 Wails 自己的日志也收进同一份文件。
type fileLogger struct{}

func (fileLogger) Print(message string)   { logLine(message) }
func (fileLogger) Trace(message string)   { logLine("TRACE " + message) }
func (fileLogger) Debug(message string)   { logLine("DEBUG " + message) }
func (fileLogger) Info(message string)    { logLine("INFO " + message) }
func (fileLogger) Warning(message string) { logLine("WARN " + message) }
func (fileLogger) Error(message string)   { logLine("ERROR " + message) }
func (fileLogger) Fatal(message string)   { logLine("FATAL " + message) }

func showErrorBox(title, text string) {
	t, err1 := windows.UTF16PtrFromString(title)
	m, err2 := windows.UTF16PtrFromString(text)
	if err1 != nil || err2 != nil {
		return
	}
	const mbIconError = 0x00000010
	const mbTopMost = 0x00040000
	procMessageBoxW.Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)),
		uintptr(mbIconError|mbTopMost))
}

// reportStartupFailure 同时写日志 + 弹框：启动失败绝不静默。
func reportStartupFailure(title string, cause any) {
	text := fmt.Sprintf("%v", cause)
	logLine(title + "：" + text)
	showErrorBox(appName, "PortPilot 无法启动："+text+"\r\n\r\n详细日志："+logFilePath())
}

func logStartupBanner() {
	logLine(fmt.Sprintf("=== 启动 PortPilot %s（pid %d）===", appVersion, os.Getpid()))
	logLine("exeDir=" + exeDir())
	logLine("appDataDir=" + appDataDir())
	logLine("vergeDataDir=" + vergeDataDir())
}
