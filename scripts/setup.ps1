# laminae 环境检查（Windows）
#
#   powershell -File scripts/setup.ps1              只检查，缺什么就打印安装命令，不改系统
#   powershell -File scripts/setup.ps1 -Install     缺 git 或 node 时，用 winget 安装（每一项先确认）
#   powershell -File scripts/setup.ps1 -Install -Yes  同上，不再逐项确认
#
# 检查项：git 是否存在；node 是否存在，并且能直接运行 .ts 文件。
# 后一项是实际运行一小段 TypeScript 得到的结论，不是凭版本号猜。
# 退出码：0 环境可用，1 有缺项。
param(
  [switch]$Install,
  [switch]$Yes
)

function Test-Command([string]$name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# 用一段最小的 TypeScript 验证 node 能直接运行 .ts（不带任何参数）
function Test-NodeRunsTs {
  $probe = Join-Path ([IO.Path]::GetTempPath()) ("laminae-probe-" + $PID + ".ts")
  try {
    Set-Content -Path $probe -Value 'const n: number = 1; console.log("laminae-ok" + n);' -Encoding ASCII
    $out = & node $probe 2>$null
    return ($LASTEXITCODE -eq 0 -and "$out" -match "laminae-ok1")
  } catch {
    return $false
  } finally {
    Remove-Item -Path $probe -ErrorAction SilentlyContinue
  }
}

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

function Get-State {
  $state = @{ Git = Test-Command "git"; Node = Test-Command "node"; Ts = $false }
  if ($state.Node) { $state.Ts = Test-NodeRunsTs }
  return $state
}

function Show-State($state) {
  if ($state.Git) { Write-Host ("[ok]   git   " + (& git --version)) } else { Write-Host "[缺]   git   未找到" }
  if (-not $state.Node) {
    Write-Host "[缺]   node  未找到"
  } elseif ($state.Ts) {
    Write-Host ("[ok]   node  " + (& node --version) + "，可以直接运行 .ts")
  } else {
    Write-Host ("[不行] node  " + (& node --version) + "，不能直接运行 .ts（通常是版本太旧）")
  }
}

function Confirm-Step([string]$what) {
  if ($Yes) { return $true }
  $answer = Read-Host "$what  继续？[y/N]"
  return ($answer -match "^(y|yes)$")
}

function Invoke-WingetInstall([string]$id, [string]$what) {
  if (-not (Test-Command "winget")) {
    Write-Host "没有 winget，无法自动安装 $what。请手动安装。"
    return
  }
  if (-not (Confirm-Step "将用 winget 安装 $what（$id）")) {
    Write-Host "已跳过 $what"
    return
  }
  & winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements
}

$state = Get-State
Show-State $state
$ok = $state.Git -and $state.Node -and $state.Ts

if ($ok) {
  Write-Host "`n环境可用。"
  exit 0
}

if ($Install) {
  if (-not $state.Git) { Invoke-WingetInstall "Git.Git" "git" }
  if (-not $state.Node -or -not $state.Ts) { Invoke-WingetInstall "OpenJS.NodeJS.LTS" "Node.js (LTS)" }
  Update-SessionPath
  Write-Host "`n重新检查："
  $state = Get-State
  Show-State $state
  if ($state.Git -and $state.Node -and $state.Ts) {
    Write-Host "`n环境可用。"
    exit 0
  }
  Write-Host "`n仍有缺项。刚装完的程序可能要重新打开终端才会生效，请重开终端后再运行本脚本。"
  exit 1
}

Write-Host "`n缺项的安装方式："
if (-not $state.Git) { Write-Host "  git   winget install --id Git.Git -e --source winget" }
if (-not $state.Node -or -not $state.Ts) { Write-Host "  node  winget install --id OpenJS.NodeJS.LTS -e --source winget" }
Write-Host "也可以让本脚本代装：powershell -File scripts/setup.ps1 -Install"
exit 1
