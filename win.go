package main

import (
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// 无边框窗口的原生行为：拖动与缩放交给系统自己的窗口回路。
// 窗口外形（模板 window_shape.go 移植）：用 SetWindowRgn 裁 32px 圆角，
// 与侧栏 20px 圆角 + 12px 外距同心（圆心同为 (32,32)）；最大化时清掉区域。
//
// 与模板的差异：PortPilot 的宿主是 Wails，没有独立 Go wndproc 可子类化
// （模板自己开窗才接管 GWLP_WNDPROC）。这里不做双重子类化，改为：
//   1) WM_SIZE / WM_DPICHANGED 由挂在前端的 Resize 监听触发 refreshWindowShape；
//   2) 另起一个轻量 goroutine 轮询 IsZoomed（140ms），最大化/还原时清掉或重设区域，
//      顺便把 is-maximized 状态推给前端（html class，见 app.js）。
// 拖动/缩放回路的其余部分仍交给系统的 WM_NCLBUTTONDOWN 方案（不受影响）。

const (
	wmNCLButtonDown = 0x00A1
	htCaption       = 2

	htLeft        = 10
	htRight       = 11
	htTop         = 12
	htTopLeft     = 13
	htTopRight    = 14
	htBottom      = 15
	htBottomLeft  = 16
	htBottomRight = 17

	// S2 窗口圆角：32 DIP（圆心 (32,32)），与 --window-radius token 一致
	cornerRadiusDIP = 32.0
)

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	shell32                      = windows.NewLazySystemDLL("shell32.dll")
	gdi32                        = windows.NewLazySystemDLL("gdi32.dll")
	procEnumWindows              = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procReleaseCapture           = user32.NewProc("ReleaseCapture")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procGetWindowTextW           = user32.NewProc("GetWindowTextW")
	procGetDpiForWindow          = user32.NewProc("GetDpiForWindow")
	procIsZoomed                 = user32.NewProc("IsZoomed")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procSetWindowRgn             = user32.NewProc("SetWindowRgn")
	procCreateRoundRectRgn       = gdi32.NewProc("CreateRoundRectRgn")
	procDeleteObject             = gdi32.NewProc("DeleteObject")
	procShellExecuteW            = shell32.NewProc("ShellExecuteW")
)

type winRect struct {
	Left, Top, Right, Bottom int32
}

func mainWindowHandle() uintptr {
	pid := windows.GetCurrentProcessId()
	var found uintptr
	cb := syscall.NewCallback(func(hwnd uintptr, _ uintptr) uintptr {
		var wpid uint32
		procGetWindowThreadProcessID.Call(hwnd, uintptr(unsafe.Pointer(&wpid)))
		if wpid != pid {
			return 1
		}
		if vis, _, _ := procIsWindowVisible.Call(hwnd); vis == 0 {
			return 1
		}
		var buf [64]uint16
		n, _, _ := procGetWindowTextW.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
		if n == 0 {
			return 1
		}
		found = hwnd
		return 0 // 找到即停
	})
	procEnumWindows.Call(cb, 0)
	return found
}

// applyWindowShape 按当前尺寸与 DPI 重新设置窗口圆角区域（模板 window_shape.go 原逻辑）。
func applyWindowShape(hwnd uintptr) {
	if hwnd == 0 {
		return
	}

	// 最大化时系统不给圆角，这里同样清掉区域。
	// 幂等：已经没有区域时再清一次也没有副作用。
	if zoomed, _, _ := procIsZoomed.Call(hwnd); zoomed != 0 {
		procSetWindowRgn.Call(hwnd, 0, 1)
		return
	}

	var rect winRect
	if ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect))); ok == 0 {
		return
	}
	w := int(rect.Right - rect.Left)
	h := int(rect.Bottom - rect.Top)
	if w <= 0 || h <= 0 {
		return
	}

	dpi, _, _ := procGetDpiForWindow.Call(hwnd)
	if dpi == 0 {
		dpi = 96
	}
	diameter := int(cornerRadiusDIP*float64(dpi)/96.0+0.5) * 2

	// +1：区域右/下边界是开区间，尺寸要多给 1px 才不会切掉一列像素
	rgn, _, _ := procCreateRoundRectRgn.Call(0, 0, uintptr(w+1), uintptr(h+1),
		uintptr(diameter), uintptr(diameter))
	if rgn == 0 {
		return
	}
	// 成功后区域归系统所有，不能再 DeleteObject。
	// 注意：SetWindowRgn 传 NULL 清空时成功也返回非 0；这里传了新区域，
	// 失败才返回 0，需要 DeleteObject 兜底回收。
	if ok, _, _ := procSetWindowRgn.Call(hwnd, rgn, 1); ok == 0 {
		procDeleteObject.Call(rgn)
	}
}

// refreshWindowShape 供外部在尺寸 / DPI 变化时调用（main.go OnStartup 里通过
// app 注册 Resize/DPICHANGED 事件回调，见 app.go）。幂等，找不到窗口时静默返回。
func refreshWindowShape() {
	applyWindowShape(mainWindowHandle())
}

// watchWindowState 轻量轮询窗口最大化状态：变化时同步裁角，
// 并把 is-maximized 推给前端（html.is-maximized，CSS 归零圆角与描边）。
// 每 140ms 一次 IsZoomed，代价可忽略；stopCh 关闭即退出。
func watchWindowState(stop <-chan struct{}, onMaximized func(bool)) {
	lastZoomed := -1 // -1 = 未采样
	for {
		select {
		case <-stop:
			return
		case <-time.After(140 * time.Millisecond):
		}
		hwnd := mainWindowHandle()
		if hwnd == 0 {
			continue
		}
		zoomed := 0
		if z, _, _ := procIsZoomed.Call(hwnd); z != 0 {
			zoomed = 1
		}
		// 每次采样都无条件按当前状态同步区域：最大化清掉、还原重裁。
		// 不能依赖 SetWindowRgn 的返回值——传 NULL 清空时成功也返回非 0，
		// `if ok == 0 { DeleteObject }` 只对「传了新区域但失败」成立。
		applyWindowShape(hwnd)
		if zoomed != lastZoomed {
			lastZoomed = zoomed
			if onMaximized != nil {
				onMaximized(zoomed == 1)
			}
		}
	}
}

func beginNativeDrag() {
	hwnd := mainWindowHandle()
	if hwnd == 0 {
		return
	}
	procReleaseCapture.Call()
	procSendMessageW.Call(hwnd, uintptr(wmNCLButtonDown), uintptr(htCaption), 0)
}

func beginNativeResize(hitTest int) {
	hwnd := mainWindowHandle()
	if hwnd == 0 {
		return
	}
	procReleaseCapture.Call()
	procSendMessageW.Call(hwnd, uintptr(wmNCLButtonDown), uintptr(hitTest), 0)
}

func hitTestForEdge(edge string) int {
	switch edge {
	case "left":
		return htLeft
	case "right":
		return htRight
	case "top":
		return htTop
	case "topleft":
		return htTopLeft
	case "topright":
		return htTopRight
	case "bottom":
		return htBottom
	case "bottomleft":
		return htBottomLeft
	case "bottomright":
		return htBottomRight
	}
	return htLeft
}

func shellOpen(path string) error {
	verb, _ := windows.UTF16PtrFromString("open")
	file, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	r, _, callErr := procShellExecuteW.Call(0,
		uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, 1 /* SW_SHOWNORMAL */)
	if r <= 32 {
		return callErr
	}
	return nil
}

func processRunning(name string) bool {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(snap)

	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	target := strings.ToLower(name) + ".exe"
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		if strings.ToLower(windows.UTF16ToString(entry.ExeFile[:])) == target {
			return true
		}
	}
	return false
}
