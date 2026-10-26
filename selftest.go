package main

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

// --selftest：不弹窗、不改配置，只验证宿主与内嵌资源，结果写入 exe 旁的 selftest.txt。

func attachParentConsole() {
	kernel32 := windows.NewLazySystemDLL("kernel32.dll")
	attach := kernel32.NewProc("AttachConsole")
	const attachParentProcess = ^uintptr(0) // (DWORD)-1
	if r, _, _ := attach.Call(attachParentProcess); r != 0 {
		if f, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
			os.Stdout = f
			os.Stderr = f
		}
	}
}

func runSelfTest() int {
	attachParentConsole()
	ensureAppDirs()

	var lines []string
	failures := 0
	check := func(name string, ok bool, detail string) {
		status := "PASS "
		if !ok {
			status = "FAIL "
			failures++
		}
		if detail != "" {
			lines = append(lines, status+name+"  :: "+detail)
		} else {
			lines = append(lines, status+name)
		}
	}
	skip := func(name, detail string) {
		lines = append(lines, "SKIP "+name+"  :: "+detail)
	}
	info := func(name, detail string) {
		lines = append(lines, "INFO "+name+"  :: "+detail)
	}

	// 1. 路径
	check("paths.appdata", dirExists(appDataDir()), appDataDir())
	check("paths.clashConfig", fileExists(clashConfigPath()), clashConfigPath())

	// 2. 单文件 exe：界面资源必须全部内嵌
	assets, subErr := fs.Sub(webAssets, "src/web")
	if subErr != nil {
		check("embed.root", false, subErr.Error())
	} else {
		for _, name := range []string{"index.html", "js/app.js", "css/app.css", "shared/api.js", "shared/core.js"} {
			_, statErr := fs.Stat(assets, name)
			check("embed."+strings.ReplaceAll(name, "/", "_"), statErr == nil, name)
		}
	}

	// 3. Clash Verge 与内核
	if processRunning("clash-verge") {
		lines = append(lines, "PASS verge.process  :: Clash Verge 正在运行")
	} else {
		skip("verge.process", "Clash Verge 未运行")
	}

	pipe := discoverPipe(true)
	if pipe == "" {
		skip("core.pipe", pipeError())
		skip("core.version", "没有管道")
		skip("core.configs", "没有管道")
	} else {
		check("core.pipe", true, pipe)
		setPipeSecret(declaredSecret())
		v := requestOnPipe(pipe, "GET", "/version", "", 4000)
		check("core.version", v != nil && v.Status == 200,
			func() string {
				if v == nil {
					return "无响应"
				}
				return fmt.Sprintf("%d %s", v.Status, trim(v.Body, 80))
			}())
		if v != nil && v.Status == 200 {
			c := requestOnPipe(pipe, "GET", "/configs", "", 6000)
			body := ""
			if c != nil {
				body = c.Body
			}
			check("core.configs", c != nil && c.Status == 200,
				fmt.Sprintf("%v len=%d", statusOf(c), len(body)))
			if c != nil && c.Status == 200 {
				var conf map[string]any
				if err := json.Unmarshal([]byte(body), &conf); err == nil {
					if mixed, isNum := conf["mixed-port"].(float64); isNum && int(mixed) > 0 {
						info("core.mixedPort", fmt.Sprintf("%d", int(mixed)))
						check("net.probeListening", tcpProbe(int(mixed), 500*time.Millisecond),
							fmt.Sprintf("127.0.0.1:%d 应当可连接", int(mixed)))
					}
				}
			}
		}
	}

	// 4. 文件原语（在 AppData 内做，避免污染）
	func() {
		probeDir := filepath.Join(appDataDir(), "selftest")
		target := filepath.Join(probeDir, "sample.txt")
		backup := filepath.Join(probeDir, "sample.bak")
		const first = "第一版\r\n"
		const second = "第二版\r\n"

		if err := writeTextFileAtomic(target, first); err != nil {
			check("file.atomicWrite", false, err.Error())
			return
		}
		got, err := readTextFile(target)
		check("file.atomicWrite", err == nil && got == first, "写入后回读一致（含中文）")

		if _, err := backupFile(target, probeDir, "sample.bak"); err != nil {
			check("file.backupRestore", false, err.Error())
		} else {
			_ = writeTextFileAtomic(target, second)
			restoreErr := restoreFile(backup, target)
			got2, _ := readTextFile(target)
			check("file.backupRestore", restoreErr == nil && got2 == first, "备份与还原一致")
		}

		if b, err := os.ReadFile(target); err == nil && len(b) > 0 {
			check("file.noBom", b[0] != 0xEF, "写出的文件不带 BOM")
		} else {
			check("file.noBom", false, "读不到探针文件")
		}
	}()

	// 5. 端口探测
	func() {
		p := probePort(1)
		_, hasListen := p["listening"]
		_, hasBind := p["bindable"]
		check("net.probeApi", hasListen && hasBind, "probe 返回结构正确")
	}()

	// 6. 主题
	lines = append(lines, "PASS theme.read  :: 当前 "+themeMode())

	// 7. JSON 往返
	func() {
		raw, _ := json.Marshal(map[string]any{"a": 1, "b": "中文"})
		var back map[string]any
		if err := json.Unmarshal(raw, &back); err == nil && back["b"] == "中文" {
			check("json.roundtrip", true, string(raw))
		} else {
			check("json.roundtrip", false, "往返失败")
		}
	}()

	lines = append(lines, "")
	if failures == 0 {
		lines = append(lines, "结果：全部通过")
	} else {
		lines = append(lines, fmt.Sprintf("结果：有 %d 项失败", failures))
	}

	report := strings.Join(lines, "\r\n")
	logPath := filepath.Join(exeDir(), "selftest.txt")
	_ = os.WriteFile(logPath, []byte(report), 0o644)
	fmt.Println(report)

	if failures == 0 {
		return 0
	}
	return 1
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func statusOf(r *pipeResponse) any {
	if r == nil {
		return "无响应"
	}
	return r.Status
}

func trim(s string, max int) string {
	s = strings.ReplaceAll(strings.ReplaceAll(s, "\r", " "), "\n", " ")
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
