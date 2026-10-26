package main

import (
	"time"

	"golang.org/x/sys/windows/registry"
)

// 跟随系统的深色/浅色判定，并转发系统变化。

const personalizeKey = `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`

func themeIsLight() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, personalizeKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue("AppsUseLightTheme")
	if err != nil {
		return false
	}
	return v != 0
}

func themeMode() string {
	if themeIsLight() {
		return "light"
	}
	return "dark"
}

// watchTheme 轮询注册表（2 秒一次，代价极小），主题变化时回调。
func watchTheme(stop <-chan struct{}, onChange func(string)) {
	last := themeIsLight()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			now := themeIsLight()
			if now == last {
				continue
			}
			last = now
			mode := "dark"
			if now {
				mode = "light"
			}
			if onChange != nil {
				onChange(mode)
			}
		}
	}
}
