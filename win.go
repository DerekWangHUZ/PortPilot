package main

import (
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// 无边框窗口的原生行为：拖动与缩放交给系统自己的窗口回路。

const (
	wmNCLButtonDown = 0x00A1
	htCaption       = 2

	htLeft       = 10
	htRight      = 11
	htTop        = 12
	htTopLeft    = 13
	htTopRight   = 14
	htBottom     = 15
	htBottomLeft = 16
	htBottomRight = 17
)

var (
	user32                       = windows.NewLazySystemDLL("user32.dll")
	shell32                      = windows.NewLazySystemDLL("shell32.dll")
	procEnumWindows              = user32.NewProc("EnumWindows")
	procGetWindowThreadProcessID = user32.NewProc("GetWindowThreadProcessId")
	procIsWindowVisible          = user32.NewProc("IsWindowVisible")
	procReleaseCapture           = user32.NewProc("ReleaseCapture")
	procSendMessageW             = user32.NewProc("SendMessageW")
	procGetWindowTextW           = user32.NewProc("GetWindowTextW")
	procShellExecuteW            = shell32.NewProc("ShellExecuteW")
)

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
