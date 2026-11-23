package main

import (
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// 无边框窗口的原生行为。拖动与缩放都不在这里做：Wails 内置的
// CSSDragProperty（--wails-draggable）负责拖动，frameless + DisableResize:false
// 让运行时在 navigationCompleted 里开启 enableResize，mousedown 时由宿主
// PostMessage(WM_NCLBUTTONDOWN, HT*) 启动缩放回路。我们只负责窗口外形。
//
// 窗口外形（模板 window_shape.go 移植）：用 SetWindowRgn 裁 32px 圆角，
// 与侧栏 20px 圆角 + 12px 外距同心（圆心同为 (32,32)）；最大化时清掉区域。
//
// 与旧版的差异：
//  1. 不再每 140ms 无条件重设区域。SetWindowRgn 每次调用都会让窗口重绘，
//     并可能让系统投影/描边抖动；改为一次性接管窗口过程，只在
//     WM_SIZE / WM_DPICHANGED 时重裁（与 macUI-SolidGlass 一致）。
//  2. 拖动/缩放不再由 Go 侧 SendMessage 发起：在 WebView2 的消息处理里同步
//     SendMessage(WM_NCLBUTTONDOWN) 会让移动回路立即退出，表现为窗口拖不动。

const (
	wmSize       = 0x0005
	wmDpiChanged = 0x02E0
	gwlWndProc   = ^uintptr(3) // GWLP_WNDPROC = -4

	// S2 窗口圆角：32 DIP（圆心 (32,32)），与 --window-radius token 一致
	cornerRadiusDIP = 32.0
)

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	shell32                      = windows.NewLazySystemDLL("shell32.dll")
	gdi32                        = windows.NewLazySystemDLL("gdi32.dll")
	kernel32                     = windows.NewLazySystemDLL("kernel32.dll")
	procEnumWindows              = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procGetWindowTextW           = user32.NewProc("GetWindowTextW")
	procGetDpiForWindow          = user32.NewProc("GetDpiForWindow")
	procIsZoomed                 = user32.NewProc("IsZoomed")
	procGetWindowRect            = user32.NewProc("GetWindowRect")
	procSetWindowRgn             = user32.NewProc("SetWindowRgn")
	procSetWindowLongPtrW        = user32.NewProc("SetWindowLongPtrW")
	procCallWindowProcW          = user32.NewProc("CallWindowProcW")
	procCreateRoundRectRgn       = gdi32.NewProc("CreateRoundRectRgn")
	procDeleteObject             = gdi32.NewProc("DeleteObject")
	procShellExecuteW            = shell32.NewProc("ShellExecuteW")
	procLoadIconW                = user32.NewProc("LoadIconW")
	procGetModuleHandleW         = kernel32.NewProc("GetModuleHandleW")

	shapeHWND   uintptr
	prevWndProc uintptr
)

type winRect struct {
	Left, Top, Right, Bottom int32
}

// mainWindowHandle 找出本进程那个可见、有标题的顶层窗口。
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

// installWindowShape 接管窗口过程，在尺寸 / DPI 变化时重新裁剪；只安装一次。
func installWindowShape(hwnd uintptr) {
	shapeHWND = hwnd
	if prevWndProc == 0 {
		cb := syscall.NewCallback(func(h, msg, wparam, lparam uintptr) uintptr {
			ret, _, _ := procCallWindowProcW.Call(prevWndProc, h, msg, wparam, lparam)
			if msg == wmSize || msg == wmDpiChanged {
				applyWindowShape(h)
			}
			return ret
		})
		prev, _, err := procSetWindowLongPtrW.Call(hwnd, gwlWndProc, cb)
		if prev == 0 || (err != nil && err != syscall.Errno(0)) {
			logLine("窗口外形：接管窗口过程失败，缩放时圆角可能不同步")
		}
		prevWndProc = prev
	}
	applyWindowShape(hwnd)
}

// installWindowShapeWhenReady 在窗口出现后立刻裁剪，避免先看到系统方角。
// 只轮询很短一段时间（窗口通常几十毫秒内就出现），装好即结束。
func installWindowShapeWhenReady() {
	go func() {
		for i := 0; i < 200; i++ {
			if hwnd := mainWindowHandle(); hwnd != 0 {
				installWindowShape(hwnd)
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		logLine("窗口外形：等待主窗口超时，未应用圆角裁剪")
	}()
}

// watchWindowState 同步最大化状态给前端（html.is-maximized，CSS 归零圆角与描边）。
// 只做状态采样：找到窗口后缓存句柄，之后每 140ms 只问一次 IsZoomed。
// 圆角区域由窗口过程在 WM_SIZE 里维护，这里不再重设。
func watchWindowState(stop <-chan struct{}, onMaximized func(bool)) {
	var hwnd uintptr
	lastZoomed := -1 // -1 = 未采样
	for {
		select {
		case <-stop:
			return
		case <-time.After(140 * time.Millisecond):
		}
		if hwnd == 0 {
			hwnd = mainWindowHandle()
			if hwnd == 0 {
				continue
			}
		}
		zoomed := 0
		if z, _, _ := procIsZoomed.Call(hwnd); z != 0 {
			zoomed = 1
		}
		if zoomed != lastZoomed {
			lastZoomed = zoomed
			if onMaximized != nil {
				onMaximized(zoomed == 1)
			}
		}
	}
}

// loadAppIcon 按 Wails 的约定（AppIconID = 3）加载本 exe 的应用图标。
// 返回 0 表示资源缺失——winresgen 把图标组注册成命名资源时就会这样。
func loadAppIcon() uintptr {
	hInst, _, _ := procGetModuleHandleW.Call(0)
	icon, _, _ := procLoadIconW.Call(hInst, 3)
	return icon
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
