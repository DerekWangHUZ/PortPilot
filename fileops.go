package main

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// 文件原语：读、原子写、备份、还原。写入一律 UTF-8 无 BOM。

func fileExists(path string) bool {
	if path == "" {
		return false
	}
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

func readTextFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", errors.New("找不到文件：" + path)
		}
		return "", err
	}
	// 容忍 BOM
	if len(b) >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF {
		b = b[3:]
	}
	return string(b), nil
}

func writeTextFile(path, text string) error {
	if dir := filepath.Dir(path); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	return os.WriteFile(path, []byte(text), 0o644)
}

// writeTextFileAtomic 先写临时文件再改名，避免出现半截文件。
func writeTextFileAtomic(path, text string) error {
	if dir := filepath.Dir(path); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	tmp := path + ".portpilot-tmp"
	if err := os.WriteFile(tmp, []byte(text), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		// 目标被占用等情况退回直接写
		if werr := os.WriteFile(path, []byte(text), 0o644); werr != nil {
			_ = os.Remove(tmp)
			return werr
		}
		_ = os.Remove(tmp)
	}
	return nil
}

func backupFile(path, backupDir, label string) (string, error) {
	if !fileExists(path) {
		return "", nil
	}
	if err := os.MkdirAll(backupDir, 0o755); err != nil {
		return "", err
	}
	safe := label
	if safe == "" {
		safe = "file"
	}
	dest := filepath.Join(backupDir, safe)
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if err := os.WriteFile(dest, b, 0o644); err != nil {
		return "", err
	}
	return dest, nil
}

func restoreFile(backupPath, target string) error {
	b, err := os.ReadFile(backupPath)
	if err != nil {
		return errors.New("找不到备份：" + backupPath)
	}
	if dir := filepath.Dir(target); dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	return os.WriteFile(target, b, 0o644)
}

func listFiles(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{}
	}
	out := []string{}
	for _, e := range entries {
		if !e.IsDir() {
			out = append(out, filepath.Join(dir, e.Name()))
		}
	}
	sort.Slice(out, func(i, j int) bool { return lessFold(out[i], out[j]) })
	return out
}

func dirNames(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{}
	}
	out := []string{}
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	sort.Slice(out, func(i, j int) bool { return lessFold(out[i], out[j]) })
	return out
}

func lessFold(a, b string) bool {
	la, lb := lower(a), lower(b)
	if la == lb {
		return a < b
	}
	return la < lb
}

func lower(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' {
			b[i] += 'a' - 'A'
		}
	}
	return string(b)
}

func deleteFile(path string) {
	if path == "" {
		return
	}
	_ = os.Remove(path)
}

func ensureDir(dir string) {
	if dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
}

func sizeOf(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return -1
	}
	return st.Size()
}

func modifiedOf(path string) string {
	st, err := os.Stat(path)
	if err != nil {
		return time.Time{}.Format(time.RFC3339Nano)
	}
	return st.ModTime().Format(time.RFC3339Nano)
}
