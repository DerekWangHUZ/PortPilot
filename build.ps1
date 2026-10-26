# PortPilot 构建脚本（Wails v2 + Go）
# 职责：准备界面资源 -> 生成 Windows 资源 -> 编译单文件 exe -> 校验 -> 自检
# 产物：dist\PortPilot.exe —— 单个可执行文件，界面与全部依赖都内嵌在里面
[CmdletBinding()]
param(
    [switch]$SkipSelfTest,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcWeb = Join-Path $Root 'src\web'
$SrcShared = Join-Path $Root 'src\shared'
$Dist = Join-Path $Root 'dist'
$OutExe = Join-Path $Dist 'PortPilot.exe'
$Syso = Join-Path $Root 'wails_winres_amd64.syso'
$GoTmp = Join-Path $Root 'tools\gotmp'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# 模块缓存优先离线；缓存里缺依赖时自动联网补齐，避免新克隆直接构建失败
$env:GOFLAGS = '-mod=mod'
$env:GOPROXY = 'https://proxy.golang.org,direct'
$env:GOSUMDB = 'sum.golang.org'
$env:GOTMPDIR = $GoTmp
# 残缺的 GIT_CONFIG_* 会让 go 的 VCS 探测以 128 退出，这里回避；构建本身也不需要 VCS 信息
Remove-Item Env:GIT_CONFIG_COUNT -ErrorAction SilentlyContinue
Remove-Item Env:GIT_CONFIG_VALUE_0 -ErrorAction SilentlyContinue

if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    foreach ($c in @("$env:ProgramFiles\Go\bin", "$env:LOCALAPPDATA\Programs\Go\bin")) {
        if (Test-Path (Join-Path $c 'go.exe')) { $env:PATH = "$c;$env:PATH"; break }
    }
}
if (-not (Get-Command go -ErrorAction SilentlyContinue)) { throw '找不到 go，请先安装 Go 1.21+ 并加入 PATH' }

New-Item -ItemType Directory -Force -Path $Dist | Out-Null
New-Item -ItemType Directory -Force -Path $GoTmp | Out-Null

if ($Clean) {
    Write-Step '清理 dist'
    if (Test-Path $Dist) { Remove-Item -LiteralPath $Dist -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Dist | Out-Null
}

# ------------------------------------------- 1. 界面资源（go:embed 只认 src\web）
Write-Step '准备界面资源'
$SharedTarget = Join-Path $SrcWeb 'shared'
New-Item -ItemType Directory -Force -Path $SharedTarget | Out-Null
Copy-Item -Path (Join-Path $SrcShared '*.js') -Destination $SharedTarget -Force
$sharedCount = @(Get-ChildItem $SharedTarget -Filter '*.js' -File).Count
if ($sharedCount -eq 0) { throw "没有找到共享逻辑：$SrcShared" }
Write-Ok "src\shared -> src\web\shared（$sharedCount 个文件）"

# --------------------------------------- 2. Windows 资源（图标/版本信息/DPI 清单）
Write-Step '生成 Windows 资源'
Push-Location (Join-Path $Root 'build\winresgen')
try {
    $genOut = & go run . $Root 2>&1
    if ($LASTEXITCODE -ne 0) {
        $genOut | ForEach-Object { Write-Host "    $_" }
        throw "资源生成失败（exit=$LASTEXITCODE）"
    }
} finally { Pop-Location }
if (-not (Test-Path $Syso)) { throw "没有生成 $Syso" }
Write-Ok ("wails_winres_amd64.syso  " + [Math]::Round((Get-Item $Syso).Length / 1KB, 1) + ' KB（图标 + 版本信息 + PerMonitorV2 清单）')

# --------------------------------------------------------------- 3. 编译宿主
Write-Step '编译宿主'
& go build -buildvcs=false -tags desktop,production -trimpath -ldflags '-s -w -H windowsgui' -o $OutExe .
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $OutExe)) { throw "编译失败（exit=$LASTEXITCODE）" }
Write-Ok ("PortPilot.exe  " + [Math]::Round((Get-Item $OutExe).Length / 1MB, 2) + ' MB')

# ------------------------------------------------------------------- 4. 校验
Write-Step '校验产物'
$ascii = [System.Text.Encoding]::ASCII.GetString([System.IO.File]::ReadAllBytes($OutExe))
if ($ascii.Contains('will not build without the correct build tags')) {
    throw '漏了 -tags desktop,production —— 编进去的是 Wails 占位实现'
}
Write-Ok '没有 Wails 占位实现（构建标签正确）'
$vi = (Get-Item $OutExe).VersionInfo
if ($vi.ProductName) {
    Write-Ok ("版本资源：" + $vi.ProductName + ' ' + $vi.FileVersion + ' / ' + $vi.CompanyName)
} else {
    Write-Warn '没有读到版本资源（图标/版本信息可能没链上）'
}

# 临时资源文件用完即删，保持仓库干净
Remove-Item -LiteralPath $Syso -Force -ErrorAction SilentlyContinue

# 去掉"来自 Internet"标记：带标记的 exe 双击会弹「无法验证发布者」安全警告，
# 而那个警告的"运行"路径会用受限令牌启动，连自己的数据目录都写不进去。
try {
    Unblock-File -LiteralPath $OutExe -ErrorAction Stop
    Write-Ok '已清除下载标记（双击不会再弹安全警告）'
} catch {
    Write-Warn '清除下载标记失败：' + $_.Exception.Message
}
try { Remove-Item -LiteralPath $OutExe -Stream Zone.Identifier -Force -ErrorAction Stop } catch { }

# 校正目录完整性标签：目录若被标成 Low，Windows 会把这里的 exe 当不可信程序——
# 双击先弹「无法验证发布者」，再以受限身份运行（写不进用户目录，也连不上 Clash Verge 的管道）。
# 这一步保证原地双击就能正常运行。
$label = (cmd /c "icacls `"$Root`"" 2>&1 | Select-String -Pattern 'Mandatory Label' | Select-Object -First 1)
if ($label -and $label -notmatch 'Medium') {
    Write-Step '校正目录完整性标签'
    cmd /c "icacls `"$Root`" /setintegritylevel (OI)(CI)Medium /T /C /Q" | Out-Null
    $after = (cmd /c "icacls `"$OutExe`"" 2>&1 | Select-String -Pattern 'Mandatory Label' | Select-Object -First 1)
    Write-Ok ('已校正为 Medium：' + ($after -replace '\s+', ' ').Trim())
} elseif ($label) {
    Write-Ok '目录完整性标签正常（Medium）'
}

# ---------------------------------------------------------------------- 自检
if (-not $SkipSelfTest) {
    Write-Step '运行自检'
    $log = Join-Path $Dist 'selftest.txt'
    if (Test-Path $log) { Remove-Item -LiteralPath $log -Force }
    $p = Start-Process -FilePath $OutExe -ArgumentList '--selftest' -Wait -PassThru -NoNewWindow
    if (Test-Path $log) {
        Get-Content -LiteralPath $log -Encoding UTF8 | ForEach-Object { Write-Host "    $_" }
        if (Get-Content -LiteralPath $log -Encoding UTF8 | Select-String -Pattern '^FAIL' -Quiet) { throw '自检存在失败项' }
    } else {
        Write-Warn "自检未生成日志（exit=$($p.ExitCode)）"
        if ($p.ExitCode -ne 0) { throw "自检进程退出码 $($p.ExitCode)" }
    }
}

Write-Step '完成'
Write-Ok "产物：$OutExe（单文件，双击即可运行）"
Write-Host ''
Write-Host '运行：' -NoNewline; Write-Host "  $OutExe" -ForegroundColor White
