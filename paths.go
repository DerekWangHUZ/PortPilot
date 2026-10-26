package main

import (
	"os"
	"path/filepath"
)

const (
	appName         = "PortPilot"
	appVersion      = "1.1"
	vergeDataFolder = "io.github.clash-verge-rev.clash-verge-rev"
	pipePrefix      = `\\.\pipe\`
)

func roamingDir() string {
	if p, err := os.UserConfigDir(); err == nil {
		return p
	}
	return os.Getenv("APPDATA")
}

func localAppDataDir() string {
	if p, err := os.UserCacheDir(); err == nil {
		return p
	}
	return os.Getenv("LOCALAPPDATA")
}

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Dir(exe)
}

func appDataDir() string      { return filepath.Join(roamingDir(), appName) }
func backupRootDir() string   { return filepath.Join(appDataDir(), "backup") }
func stateFilePath() string   { return filepath.Join(appDataDir(), "state.json") }
func runLogPath() string      { return filepath.Join(appDataDir(), "run-log.jsonl") }
func vergeDataDir() string    { return filepath.Join(roamingDir(), vergeDataFolder) }
func clashConfigPath() string { return filepath.Join(vergeDataDir(), "clash-verge.yaml") }
func profilesYamlPath() string { return filepath.Join(vergeDataDir(), "profiles.yaml") }
func profilesDirPath() string  { return filepath.Join(vergeDataDir(), "profiles") }

func ensureAppDirs() {
	for _, d := range []string{appDataDir(), backupRootDir()} {
		_ = os.MkdirAll(d, 0o755)
	}
}
