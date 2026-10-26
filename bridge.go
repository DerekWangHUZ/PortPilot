package main

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	"golang.org/x/sys/windows"
)

// Call 是前端唯一入口；方法名与返回结构固定，前端只依赖这里。
func (a *App) Call(method string, paramsJSON string) (string, error) {
	params := map[string]any{}
	if paramsJSON != "" {
		if err := json.Unmarshal([]byte(paramsJSON), &params); err != nil {
			return "", err
		}
	}
	data, err := a.dispatch(method, params)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(data)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func ok() map[string]any { return map[string]any{"ok": true} }

func (a *App) dispatch(method string, p map[string]any) (any, error) {
	switch method {
	case "window.minimize":
		runtime.WindowMinimise(a.ctx)
		return ok(), nil
	case "window.toggleMaximize":
		if runtime.WindowIsMaximised(a.ctx) {
			runtime.WindowUnmaximise(a.ctx)
		} else {
			runtime.WindowMaximise(a.ctx)
		}
		return map[string]any{"ok": true, "maximized": runtime.WindowIsMaximised(a.ctx)}, nil
	case "window.beginResize":
		beginNativeResize(hitTestForEdge(getString(p, "edge", "left")))
		return ok(), nil
	case "window.beginDrag":
		beginNativeDrag()
		return ok(), nil
	case "window.setFrame":
		// 无边框窗口的底色由 Wails 的 BackgroundColour 负责，这里无需处理
		return ok(), nil

	case "app.info":
		return a.appInfo(), nil
	case "app.exit":
		go runtime.Quit(a.ctx)
		return ok(), nil
	case "app.ping":
		return map[string]any{"pong": true}, nil

	case "pipe.discover":
		return pipeInfo(true), nil
	case "pipe.status":
		return pipeInfo(false), nil
	case "pipe.http":
		return pipeHTTP(p), nil

	case "file.read":
		text, err := readTextFile(getString(p, "path", ""))
		if err != nil {
			return nil, err
		}
		return map[string]any{"text": text}, nil
	case "file.write":
		if err := writeTextFile(getString(p, "path", ""), getString(p, "text", "")); err != nil {
			return nil, err
		}
		return ok(), nil
	case "file.writeAtomic":
		if err := writeTextFileAtomic(getString(p, "path", ""), getString(p, "text", "")); err != nil {
			return nil, err
		}
		return ok(), nil
	case "file.copy":
		text, err := readTextFile(getString(p, "from", ""))
		if err != nil {
			return nil, err
		}
		if err := writeTextFile(getString(p, "to", ""), text); err != nil {
			return nil, err
		}
		return ok(), nil
	case "file.copyRaw":
		from := getString(p, "from", "")
		to := getString(p, "to", "")
		if dir := filepath.Dir(to); dir != "" {
			_ = os.MkdirAll(dir, 0o755)
		}
		b, err := os.ReadFile(from)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(to, b, 0o644); err != nil {
			return nil, err
		}
		return ok(), nil
	case "file.exists":
		return map[string]any{"exists": fileExists(getString(p, "path", ""))}, nil
	case "file.delete":
		deleteFile(getString(p, "path", ""))
		return ok(), nil
	case "file.ensureDir":
		ensureDir(getString(p, "path", ""))
		return ok(), nil
	case "file.listFiles":
		return map[string]any{"files": listFiles(getString(p, "path", ""))}, nil
	case "file.listDirs":
		return map[string]any{"dirs": dirNames(getString(p, "path", ""))}, nil
	case "file.stat":
		path := getString(p, "path", "")
		return map[string]any{
			"exists":   fileExists(path),
			"size":     sizeOf(path),
			"modified": modifiedOf(path),
		}, nil

	case "net.probe":
		return map[string]any{"results": probePorts(getIntSlice(p, "ports"))}, nil

	case "dialog.saveText":
		return dialogSaveText(a.ctx, getString(p, "defaultName", "portpilot-config.json"), getString(p, "content", ""))
	case "dialog.openText":
		return dialogOpenText(a.ctx)
	case "dialog.confirm":
		return map[string]any{"ok": dialogConfirm(a.ctx, getString(p, "message", ""), getString(p, "title", ""))}, nil
	case "dialog.info":
		dialogInfo(a.ctx, getString(p, "message", ""), getString(p, "title", ""))
		return ok(), nil
	case "dialog.pickFolder":
		return dialogPickFolder(a.ctx, getString(p, "title", ""))

	case "shell.reveal":
		revealPath(getString(p, "path", ""))
		return ok(), nil
	case "shell.open":
		if err := shellOpen(getString(p, "path", "")); err != nil {
			return nil, err
		}
		return ok(), nil

	case "theme.get":
		return map[string]any{"mode": themeMode(), "light": themeIsLight()}, nil
	}
	return nil, errors.New("未知的调用：" + method)
}

func (a *App) appInfo() map[string]any {
	return map[string]any{
		"app":              appName,
		"version":          appVersion,
		"debug":            false,
		"exeDir":           exeDir(),
		"appDataDir":       appDataDir(),
		"backupDir":        backupRootDir(),
		"stateFile":        stateFilePath(),
		"runLogFile":       runLogPath(),
		"vergeDir":         vergeDataDir(),
		"clashConfigPath":  clashConfigPath(),
		"profilesYamlPath": profilesYamlPath(),
		"profilesDir":      profilesDirPath(),
		"theme":            themeMode(),
		"light":            themeIsLight(),
		"vergeRunning":     processRunning("clash-verge"),
		"coreRunning":      processRunning("verge-mihomo"),
	}
}

func pipeInfo(force bool) map[string]any {
	pipe := discoverPipe(force)
	res := map[string]any{
		"pipe":    nil,
		"error":   pipeError(),
		"core":    false,
		"version": nil,
		"secret":  pipeSecretValue(),
	}
	if pipe == "" {
		return res
	}
	setPipeSecret(declaredSecret())
	version := any(nil)
	core := false
	if v := requestOnPipe(pipe, "GET", "/version", "", 2500); v != nil && v.Status == 200 {
		version = v.Body
		core = true
	}
	res["pipe"] = pipe
	res["version"] = version
	res["core"] = core
	res["secret"] = pipeSecretValue()
	if core {
		res["error"] = ""
	}
	return res
}

func pipeHTTP(p map[string]any) map[string]any {
	method := getString(p, "method", "GET")
	path := getString(p, "path", "/")
	timeout := getInt(p, "timeout", 20000)

	bodyText := ""
	if raw, exists := p["body"]; exists && raw != nil {
		if b, err := json.Marshal(raw); err == nil {
			bodyText = string(b)
		}
	}

	resp := pipeRequest(method, path, bodyText, timeout)
	if resp == nil {
		return map[string]any{"ok": false, "error": pipeError(), "status": 0, "body": ""}
	}
	return map[string]any{
		"ok":     resp.ok(),
		"status": resp.Status,
		"reason": resp.Reason,
		"body":   resp.Body,
		"pipe":   currentPipe(),
	}
}

func revealPath(target string) {
	if target == "" {
		return
	}
	var args []string
	if st, err := os.Stat(target); err == nil && !st.IsDir() {
		args = []string{"/select," + target}
	} else {
		args = []string{target}
	}
	cmd := exec.Command("explorer.exe", args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	_ = cmd.Start()
}

/* ------------------------------------------------------------ 参数读取辅助 */

func getString(p map[string]any, key, def string) string {
	if v, exists := p[key]; exists {
		if s, isStr := v.(string); isStr {
			return s
		}
	}
	return def
}

func getInt(p map[string]any, key string, def int) int {
	if v, exists := p[key]; exists {
		switch n := v.(type) {
		case float64:
			return int(n)
		case int:
			return n
		case json.Number:
			if i, err := n.Int64(); err == nil {
				return int(i)
			}
		}
	}
	return def
}

func getIntSlice(p map[string]any, key string) []int {
	raw, exists := p[key]
	if !exists {
		return nil
	}
	arr, isArr := raw.([]any)
	if !isArr {
		return nil
	}
	out := make([]int, 0, len(arr))
	for _, item := range arr {
		if f, isNum := item.(float64); isNum {
			out = append(out, int(f))
		}
	}
	return out
}
