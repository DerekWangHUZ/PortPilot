package main

import (
	"context"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// 系统对话框：交给 Wails 运行时，行为与 WPF/WinForms 原生对话框一致。

func dialogSaveText(ctx context.Context, defaultName, content string) (map[string]any, error) {
	if defaultName == "" {
		defaultName = "portpilot-config.json"
	}
	path, err := runtime.SaveFileDialog(ctx, runtime.SaveDialogOptions{
		Title:           "导出 PortPilot 配置",
		DefaultFilename: defaultName,
		Filters: []runtime.FileFilter{
			{DisplayName: "JSON 文件 (*.json)", Pattern: "*.json"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"path": nil, "canceled": true}, nil
	}
	if err := writeTextFile(path, content); err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "canceled": false}, nil
}

func dialogOpenText(ctx context.Context) (map[string]any, error) {
	path, err := runtime.OpenFileDialog(ctx, runtime.OpenDialogOptions{
		Title: "导入 PortPilot 配置",
		Filters: []runtime.FileFilter{
			{DisplayName: "JSON 文件 (*.json)", Pattern: "*.json"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return nil, err
	}
	if path == "" {
		return map[string]any{"canceled": true}, nil
	}
	text, err := readTextFile(path)
	if err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "text": text}, nil
}

func dialogPickFolder(ctx context.Context, title string) (map[string]any, error) {
	if title == "" {
		title = "选择文件夹"
	}
	dir, err := runtime.OpenDirectoryDialog(ctx, runtime.OpenDialogOptions{Title: title})
	if err != nil {
		return nil, err
	}
	if dir == "" {
		return map[string]any{"path": nil, "canceled": true}, nil
	}
	return map[string]any{"path": dir, "canceled": false}, nil
}

func dialogInfo(ctx context.Context, message, title string) {
	if title == "" {
		title = appName
	}
	_, _ = runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:    runtime.InfoDialog,
		Title:   title,
		Message: message,
		Buttons: []string{"确定"},
	})
}

func dialogConfirm(ctx context.Context, message, title string) bool {
	if title == "" {
		title = appName
	}
	res, err := runtime.MessageDialog(ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       []string{"确定", "取消"},
		DefaultButton: "确定",
		CancelButton:  "取消",
	})
	if err != nil {
		return false
	}
	return res == "确定" || res == "Yes" || res == "OK"
}
