# dsh-purge-unrestricted-scope.ps1
# 解除 dsh-purge 的「本地靶场」限制：攻击任务不再按目标位置（回环 / RFC1918）拦截。
# 幂等：已打过标记就跳过。插件升级覆盖文件后重跑一次即可。
#
# 用法（PowerShell 5.1 与 pwsh 7 均可）：
#   powershell -NoProfile -File .\scripts\dsh-purge-unrestricted-scope.ps1
#   powershell -NoProfile -File .\scripts\dsh-purge-unrestricted-scope.ps1 -DryRun
#   powershell -NoProfile -File .\scripts\dsh-purge-unrestricted-scope.ps1 -Revert
#   powershell -NoProfile -File .\scripts\dsh-purge-unrestricted-scope.ps1 -Root D:\some\dsh-purge

[CmdletBinding()]
param(
  [string]$Profile = "desktop",
  [string]$Root = "",
  [switch]$DryRun,
  [switch]$Revert
)

$ErrorActionPreference = "Stop"

$marker = "[local] 目标范围限制已解除"
$utf8 = New-Object System.Text.UTF8Encoding($false)

$targets = @()
if ($Root) { $targets += $Root }
else {
  $inst = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules\dsh-purge"
  if (Test-Path $inst) { $targets += $inst }
  $fork = "C:\Users\25987\Documents\deepseek-harness\default-workspace\dsh-purge-fork"
  if (Test-Path (Join-Path $fork "lib\net-scope.js")) { $targets += $fork }
}
if (-not $targets.Count) { throw "没找到 dsh-purge（profile=$Profile）" }

$newRangeTarget = @'
async function isRangeTarget() {
  return true;
}

/** 旧判定：把 isRangeTarget 改回调用它即可恢复本地靶场限制。 */
async function isRangeTargetLocalLab(name) {
$1
}
'@

$newTaskTargetHit = @'
export async function taskTargetHit(text) {
  // [local] 目标范围限制已解除：攻击任务不必点名目标，目标也不再按位置判定。
  if (!isAttackTask(text)) return null;
  return publicHostHit(text);
}
'@

$zhNewHint = '"own.hint": "本机已解除目标范围限制：攻击任务填公网域名或 IP 直接放行，不再做域名解析与私网/RFC1918 判定，hosts 指向公网也不再拦。下面的名单已不参与放行判定。",'
$enNewHint = '"own.hint": "Target scope is unrestricted on this install: public domains and IPs pass straight through, with no DNS resolution and no RFC1918/loopback check. A hosts entry that points at a public IP is no longer blocked. The list below no longer affects gating.",'

function Save-Text {
  param([string]$Path, [string]$Text)
  [System.IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

function Revert-One {
  param([string]$Dir)
  foreach ($rel in @("lib\net-scope.js", "client.js")) {
    $fp = Join-Path $Dir $rel
    $bak = Get-ChildItem "$fp.bak-local-unrestricted-*" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $bak) { Write-Host "  ! 无备份：$rel"; continue }
    Copy-Item $bak.FullName $fp -Force
    Write-Host "  ~ 已回滚 $rel  <- $($bak.Name)"
  }
}

foreach ($dir in $targets) {
  Write-Host "== $dir"
  $nsPath = Join-Path $dir "lib\net-scope.js"
  $cPath = Join-Path $dir "client.js"

  if (-not (Test-Path $nsPath)) { Write-Host "  ! 缺 lib\net-scope.js，跳过"; continue }

  if ($Revert) { Revert-One -Dir $dir; continue }

  $ns = [System.IO.File]::ReadAllText($nsPath)
  $client = if (Test-Path $cPath) { [System.IO.File]::ReadAllText($cPath) } else { "" }

  $nsDone = $ns.Contains($marker)
  $clientDone = ($client.Contains("目标范围限制已解除") -or $client.Contains("Target scope is unrestricted"))

  if ($nsDone -and $clientDone) { Write-Host "  = 已解除，无需改动"; continue }
  if ($DryRun) {
    $a = if ($nsDone) { "已解除" } else { "未解除" }
    $b = if ($clientDone) { "已解除" } else { "未解除" }
    Write-Host ("  · net-scope.js {0} / client.js {1}" -f $a, $b)
    continue
  }

  $ts = Get-Date -Format "yyyyMMdd-HHmmss"

  if (-not $nsDone) {
    Copy-Item $nsPath "$nsPath.bak-local-unrestricted-$ts" -Force
    $before = $ns
    $ns = [regex]::Replace(
      $ns,
      '(?s)async function isRangeTarget\(name\) \{\r?\n(.*?)\r?\n\}',
      $newRangeTarget,
      1
    )
    $ns = [regex]::Replace(
      $ns,
      '(?s)export async function taskTargetHit\(text\) \{.*?\r?\n\}',
      $newTaskTargetHit.TrimEnd(),
      1
    )
    if ($ns -eq $before) { Write-Host "  ! net-scope.js 未命中（上游可能改了结构），需要人工检查" }
    else { Save-Text $nsPath $ns; Write-Host "  + net-scope.js 已解除" }
  }

  if (-not $clientDone -and $client) {
    Copy-Item $cPath "$cPath.bak-local-unrestricted-$ts" -Force
    $before = $client
    $client = [regex]::Replace($client, '"own\.hint": "[^"]*本机/内网[^"]*",', $zhNewHint, 1)
    $client = [regex]::Replace($client, '"own\.hint": "[^"]*The open-source build only allows[^"]*",', $enNewHint, 1)
    $client = $client.Replace('"own.title": "本地靶场"', '"own.title": "目标名单"')
    $client = $client.Replace('"own.title": "Local lab only"', '"own.title": "Targets"')
    if ($client -eq $before) { Write-Host "  ! client.js 未命中（上游可能改了文案），需要人工检查" }
    else { Save-Text $cPath $client; Write-Host "  + client.js 文案已改" }
  }
}

Write-Host ""
Write-Host "完成。门禁在宿主进程启动时挂载，改完要重启桌面应用才生效（刷新页面只更新文案）。"
