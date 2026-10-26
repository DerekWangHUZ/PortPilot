// 生成 Windows 资源 COFF 对象（.syso），复刻 Wails CLI 在 wails build 时做的事：
//   - 应用图标    build/windows/icon.ico        -> RT_GROUP_ICON "APPICON"
//   - DPI 清单    build/windows/wails.exe.manifest -> RT_MANIFEST
//   - 版本信息    build/windows/info.json       -> RT_VERSION
// 用法：go run . <项目根目录>
package main

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	root := "."
	if len(os.Args) > 1 {
		root = os.Args[1]
	}
	win := filepath.Join(root, "build", "windows")

	rs := winres.ResourceSet{}

	f, err := os.Open(filepath.Join(win, "icon.ico"))
	must(err)
	icon, err := winres.LoadICO(f)
	must(err)
	_ = f.Close()
	must(rs.SetIcon(winres.Name("APPICON"), icon))

	xml, err := os.ReadFile(filepath.Join(win, "wails.exe.manifest"))
	must(err)
	manifest, err := winres.AppManifestFromXML(xml)
	must(err)
	rs.SetManifest(manifest)

	j, err := os.ReadFile(filepath.Join(win, "info.json"))
	must(err)
	var vi version.Info
	must(json.Unmarshal(j, &vi))
	rs.SetVersionInfo(vi)

	out, err := os.Create(filepath.Join(root, "wails_winres_amd64.syso"))
	must(err)
	must(rs.WriteObject(out, winres.ArchAMD64))
	must(out.Close())
}
