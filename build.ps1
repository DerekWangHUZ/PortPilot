# PortPilot 构建脚本（Windows PowerShell 5.1+）
# 职责：准备依赖 -> 编译宿主 -> 打包 dist -> 自检
[CmdletBinding()]
param(
    [switch]$SkipSelfTest,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcHost = Join-Path $Root 'src\host'
$SrcWeb = Join-Path $Root 'src\web'
$SrcShared = Join-Path $Root 'src\shared'
$Tools = Join-Path $Root 'tools'
$Dist = Join-Path $Root 'dist'
$RoslynDir = Join-Path $Tools 'roslyn'
$WebView2Dir = Join-Path $Tools 'webview2'

$WebView2Version = '1.0.4191.47'
$RoslynVersion = '4.11.0'

$FxDir = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Get-Nupkg {
    param([string]$Id, [string]$Version, [string]$OutFile)
    $url = "https://api.nuget.org/v3-flatcontainer/$Id/$Version/$Id.$Version.nupkg"
    Write-Host "    下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $OutFile -TimeoutSec 300 -UseBasicParsing
}

function Expand-Nupkg {
    param([string]$Nupkg, [string]$Destination)
    $zip = [System.IO.Path]::ChangeExtension($Nupkg, '.zip')
    Copy-Item -LiteralPath $Nupkg -Destination $zip -Force
    if (Test-Path $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $Destination -Force
    Remove-Item -LiteralPath $zip -Force
}

if ($Clean) {
    Write-Step '清理 dist'
    if (Test-Path $Dist) { Remove-Item -LiteralPath $Dist -Recurse -Force }
}

New-Item -ItemType Directory -Force -Path $Dist | Out-Null
New-Item -ItemType Directory -Force -Path $Tools | Out-Null

# ---------------------------------------------------------------- 依赖：Roslyn
Write-Step '检查 C# 编译器（Roslyn）'
$Csc = Join-Path $RoslynDir 'csc.exe'
if (-not (Test-Path $Csc)) {
    Write-Warn '未找到 Roslyn，开始下载 Microsoft.Net.Compilers.Toolset'
    $tmp = Join-Path $env:TEMP "pp-roslyn-$RoslynVersion.nupkg"
    Get-Nupkg -Id 'microsoft.net.compilers.toolset' -Version $RoslynVersion -OutFile $tmp
    $stage = Join-Path $env:TEMP "pp-roslyn-stage-$([Guid]::NewGuid().ToString('N'))"
    Expand-Nupkg -Nupkg $tmp -Destination $stage
    $net472 = Join-Path $stage 'tasks\net472'
    if (-not (Test-Path (Join-Path $net472 'csc.exe'))) { throw 'Roslyn 包结构异常：找不到 tasks\net472\csc.exe' }
    New-Item -ItemType Directory -Force -Path $RoslynDir | Out-Null
    Copy-Item -Path (Join-Path $net472 '*') -Destination $RoslynDir -Recurse -Force
    Remove-Item -LiteralPath $stage -Recurse -Force
    Remove-Item -LiteralPath $tmp -Force
}
if (-not (Test-Path $Csc)) { throw "编译器不可用：$Csc" }
Write-Ok ((& $Csc /nologo /version 2>&1 | Select-Object -First 1))

# ------------------------------------------------------------- 依赖：WebView2
Write-Step '检查 WebView2 SDK'
$CoreDll = Join-Path $WebView2Dir 'Microsoft.Web.WebView2.Core.dll'
$WinFormsDll = Join-Path $WebView2Dir 'Microsoft.Web.WebView2.WinForms.dll'
$LoaderDll = Join-Path $WebView2Dir 'WebView2Loader.dll'
if (-not (Test-Path $CoreDll) -or -not (Test-Path $WinFormsDll) -or -not (Test-Path $LoaderDll)) {
    Write-Warn '未找到 WebView2 SDK，开始下载 Microsoft.Web.WebView2'
    $tmp = Join-Path $env:TEMP "pp-webview2-$WebView2Version.nupkg"
    Get-Nupkg -Id 'microsoft.web.webview2' -Version $WebView2Version -OutFile $tmp
    $stage = Join-Path $env:TEMP "pp-webview2-stage-$([Guid]::NewGuid().ToString('N'))"
    Expand-Nupkg -Nupkg $tmp -Destination $stage
    New-Item -ItemType Directory -Force -Path $WebView2Dir | Out-Null
    Copy-Item -LiteralPath (Join-Path $stage 'lib\net462\Microsoft.Web.WebView2.Core.dll') -Destination $WebView2Dir -Force
    Copy-Item -LiteralPath (Join-Path $stage 'lib\net462\Microsoft.Web.WebView2.WinForms.dll') -Destination $WebView2Dir -Force
    Copy-Item -LiteralPath (Join-Path $stage 'runtimes\win-x64\native\WebView2Loader.dll') -Destination $WebView2Dir -Force
    Remove-Item -LiteralPath $stage -Recurse -Force
    Remove-Item -LiteralPath $tmp -Force
}
Write-Ok "WebView2 SDK $WebView2Version"

# ------------------------------------------------------------------- 编译宿主
Write-Step '编译宿主'
$Sources = Get-ChildItem -Path $SrcHost -Filter '*.cs' -Recurse | ForEach-Object { $_.FullName }
if (-not $Sources -or $Sources.Count -eq 0) { throw "没有找到宿源码：$SrcHost" }

$OutExe = Join-Path $Dist 'PortPilot.exe'
$refs = @(
    (Join-Path $FxDir 'System.dll'),
    (Join-Path $FxDir 'System.Core.dll'),
    (Join-Path $FxDir 'System.Drawing.dll'),
    (Join-Path $FxDir 'System.Windows.Forms.dll'),
    (Join-Path $FxDir 'System.Web.Extensions.dll'),
    $CoreDll,
    $WinFormsDll
)
$refArgs = $refs | ForEach-Object { "/r:`"$_`"" }

$cscArgs = @(
    '/nologo', '/target:winexe', '/platform:x64', '/langversion:latest',
    '/optimize+', '/deterministic+',
    "/out:`"$OutExe`"",
    "/win32icon:`"$Root\assets\PortPilot.ico`""
) + $refArgs + ($Sources | ForEach-Object { "`"$_`"" })

$iconPath = Join-Path $Root 'assets\PortPilot.ico'
if (-not (Test-Path $iconPath)) {
    # 图标可选：缺失时去掉该参数
    $cscArgs = $cscArgs | Where-Object { $_ -notlike '/win32icon:*' }
}

$cscOut = & $Csc @cscArgs 2>&1
$cscOut | Where-Object { $_ -and $_ -notmatch '^Microsoft \(R\)' } | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $OutExe)) { throw "编译失败（exit=$LASTEXITCODE）" }
Write-Ok ("PortPilot.exe  " + [Math]::Round((Get-Item $OutExe).Length / 1KB, 1) + ' KB')

# --------------------------------------------------------------------- 打包资源
Write-Step '打包运行资源'
Copy-Item -LiteralPath $CoreDll -Destination $Dist -Force
Copy-Item -LiteralPath $WinFormsDll -Destination $Dist -Force
Copy-Item -LiteralPath $LoaderDll -Destination $Dist -Force

$WebTarget = Join-Path $Dist 'web'
if (Test-Path $WebTarget) { Remove-Item -LiteralPath $WebTarget -Recurse -Force }
New-Item -ItemType Directory -Force -Path $WebTarget | Out-Null
Copy-Item -Path (Join-Path $SrcWeb '*') -Destination $WebTarget -Recurse -Force
$SharedTarget = Join-Path $WebTarget 'shared'
New-Item -ItemType Directory -Force -Path $SharedTarget | Out-Null
Copy-Item -Path (Join-Path $SrcShared '*.js') -Destination $SharedTarget -Force
Copy-Item -LiteralPath (Join-Path $Root 'docs') -Destination $Dist -Recurse -Force -ErrorAction SilentlyContinue
Write-Ok "$WebTarget"

# ---------------------------------------------------------------------- 自检
if (-not $SkipSelfTest) {
    Write-Step '运行自检'
    $log = Join-Path $Dist 'selftest.txt'
    if (Test-Path $log) { Remove-Item -LiteralPath $log -Force }
    $p = Start-Process -FilePath $OutExe -ArgumentList '--selftest' -Wait -PassThru -NoNewWindow
    if (Test-Path $log) {
        Get-Content -LiteralPath $log -Encoding UTF8 | ForEach-Object { Write-Host "    $_" }
        if ((Get-Content -LiteralPath $log -Encoding UTF8 | Select-String -Pattern '^FAIL' -Quiet)) {
            throw '自检存在失败项'
        }
    } else {
        Write-Warn "自检未生成日志（exit=$($p.ExitCode)）"
        if ($p.ExitCode -ne 0) { throw "自检进程退出码 $($p.ExitCode)" }
    }
}

Write-Step '完成'
Write-Ok "产物：$OutExe"
Write-Host ''
Write-Host '运行：' -NoNewline; Write-Host "  $OutExe" -ForegroundColor White
