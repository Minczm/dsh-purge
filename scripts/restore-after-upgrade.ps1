<#
.SYNOPSIS
    插件升级后，把本仓库中被回灌/修补的文件重新同步回已安装的 dsh-purge。

.DESCRIPTION
    dsh-purge 1.1.73 起在 "open-source local-lab only" 提交里删掉了知识库与技能库
    （commit 679a3db）。本仓库的 local 分支回灌了 1.1.71 原版实现，见 commit 133e3f6。

    但 `pnpm update` / 重装会重写 node_modules 里的文件，把补丁冲掉。
    升级后跑一次本脚本即可恢复。

    本脚本只做「覆盖」，不做删除、不动 knowledge.db。
    数据（knowledge.db / pocs/）在 $DSH_HOME\redteam 下，不在插件目录，升级本就不受影响。

.PARAMETER Target
    已安装的 dsh-purge 目录。省略时自动探测（profile 优先级：desktop > web）。

.PARAMETER Repo
    本仓库根目录。省略时按脚本自身位置推断（scripts\ 的上一级）。

.PARAMETER Force
    即使文件已一致也强制复制（默认会跳过内容完全相同的文件）。

.PARAMETER WhatIfOnly
    只打印将要做什么，不实际写盘。

.EXAMPLE
    pwsh -File .\scripts\restore-after-upgrade.ps1 -WhatIfOnly
    pwsh -File .\scripts\restore-after-upgrade.ps1
    pwsh -File .\scripts\restore-after-upgrade.ps1 -Target "C:\Users\me\.dsh\profiles\web\node_modules\dsh-purge"
#>
[CmdletBinding()]
param(
    [string]$Target,
    [string]$Repo,
    [switch]$Force,
    [switch]$WhatIfOnly
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "    --  $msg" -ForegroundColor DarkGray }
function Write-Warn2($msg){ Write-Host "    !!  $msg" -ForegroundColor Yellow }

# ---------- 定位仓库 ----------
if (-not $Repo) {
    $Repo = Split-Path -Parent $PSScriptRoot
}
if (-not (Test-Path (Join-Path $Repo 'package.json'))) {
    throw "不是仓库根目录（找不到 package.json）: $Repo"
}
$repoPkg = Get-Content (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json
if ($repoPkg.name -ne 'dsh-purge') {
    throw "仓库 package.json 的 name 不是 dsh-purge，而是 '$($repoPkg.name)'"
}
Write-Step "仓库: $Repo  (v$($repoPkg.version))"

# ---------- 定位已安装的插件 ----------
if (-not $Target) {
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
    $candidates = @(
        (Join-Path $dshHome 'profiles\desktop\node_modules\dsh-purge'),
        (Join-Path $dshHome 'profiles\web\node_modules\dsh-purge')
    )
    $Target = $candidates | Where-Object { Test-Path (Join-Path $_ 'package.json') } | Select-Object -First 1
    if (-not $Target) {
        throw "找不到已安装的 dsh-purge。请用 -Target 指定，例如：`n  -Target `"$dshHome\profiles\desktop\node_modules\dsh-purge`""
    }
}
if (-not (Test-Path (Join-Path $Target 'package.json'))) {
    throw "目标目录不像 dsh-purge: $Target"
}
$targetPkg = Get-Content (Join-Path $Target 'package.json') -Raw | ConvertFrom-Json
Write-Step "目标: $Target  (v$($targetPkg.version))"

if ($targetPkg.version -ne $repoPkg.version) {
    Write-Warn2 "版本不一致：仓库 v$($repoPkg.version) vs 已安装 v$($targetPkg.version)"
    Write-Warn2 "如果刚升级过，属正常；否则先确认是不是要往旧版本上打补丁。"
}

# ---------- 要同步的文件 ----------
# 只有这 4 个 js 是被回灌/修补过的，其余文件升级后应保持新版
$files = @(
    'client.js',
    'lib\redteam\client.js',
    'lib\redteam\store-core.js',
    'lib\redteam\tools.js'
)

$copied = 0; $skipped = 0; $missing = 0

Write-Step "同步修补过的文件"
foreach ($rel in $files) {
    $src = Join-Path $Repo $rel
    $dst = Join-Path $Target $rel
    if (-not (Test-Path $src)) { Write-Warn2 "仓库缺文件: $rel"; $missing++; continue }
    if (-not (Test-Path (Split-Path -Parent $dst))) {
        Write-Warn2 "目标缺目录: $(Split-Path -Parent $rel)"; $missing++; continue
    }

    $same = $false
    if ((Test-Path $dst) -and -not $Force) {
        $a = (Get-FileHash $src -Algorithm SHA256).Hash
        $b = (Get-FileHash $dst -Algorithm SHA256).Hash
        $same = ($a -eq $b)
    }

    if ($same) {
        Write-Skip "$rel （已一致）"
        $skipped++
        continue
    }

    if ($WhatIfOnly) {
        Write-Ok "$rel （将覆盖）"
        $copied++
        continue
    }

    # 覆盖前留一份原文件（仅当与仓库不同）
    if ((Test-Path $dst) -and -not (Test-Path "$dst.pre-restore")) {
        Copy-Item $dst "$dst.pre-restore" -Force
    }
    Copy-Item $src $dst -Force
    Write-Ok "$rel"
    $copied++
}

# ---------- skills 目录 ----------
Write-Step "同步 skills/ 目录"
$srcSkills = Join-Path $Repo 'skills'
$dstSkills = Join-Path $Target 'skills'
if (-not (Test-Path $srcSkills)) {
    Write-Warn2 "仓库没有 skills/ 目录，跳过"
} else {
    $srcFiles = Get-ChildItem $srcSkills -Recurse -File
    $n = 0
    foreach ($f in $srcFiles) {
        $relPath = $f.FullName.Substring($srcSkills.Length).TrimStart('\', '/')
        $out = Join-Path $dstSkills $relPath
        if ((Test-Path $out) -and -not $Force) {
            $a = (Get-FileHash $f.FullName -Algorithm SHA256).Hash
            $b = (Get-FileHash $out -Algorithm SHA256).Hash
            if ($a -eq $b) { continue }
        }
        if ($WhatIfOnly) { $n++; continue }
        $dir = Split-Path -Parent $out
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        Copy-Item $f.FullName $out -Force
        $n++
    }
    if ($WhatIfOnly) { Write-Ok "skills/ ：$n 个文件将写入" }
    else { Write-Ok "skills/ ：写入 $n 个文件（共 $($srcFiles.Count)）" }
    $copied += $n
}

# ---------- 语法自检 ----------
if (-not $WhatIfOnly) {
    Write-Step "语法自检（node --check）"
    $node = $null
    foreach ($p in @(
        (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
        'node'
    )) {
        try {
            $cmd = Get-Command $p -ErrorAction Stop
            $node = $cmd.Source
            break
        } catch { }
    }

    if (-not $node) {
        Write-Warn2 "找不到 node，跳过语法自检"
    } else {
        $bad = 0
        foreach ($rel in $files) {
            $p = Join-Path $Target $rel
            if (-not (Test-Path $p)) { continue }
            $out = & $node --check $p 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Warn2 "$rel 语法错误：$($out -join ' ')"
                $bad++
            } else {
                Write-Skip "$rel 语法通过"
            }
        }
        if ($bad -gt 0) {
            throw "有 $bad 个文件语法不通过，请检查后再重启 DSH"
        }
    }
}

# ---------- 数据侧检查 ----------
Write-Step "数据侧（不在插件目录，升级不会动）"
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$kb = Join-Path $dshHome 'redteam\knowledge.db'
if (Test-Path $kb) {
    $size = (Get-Item $kb).Length
    Write-Ok ("knowledge.db  {0:N0} 字节" -f $size)
} else {
    Write-Warn2 "knowledge.db 不存在：$kb （首次使用会自动建）"
}

# ---------- 汇总 ----------
Write-Host ""
Write-Host ("-" * 60)
if ($WhatIfOnly) {
    Write-Host "试运行结束：$copied 项待写入，$skipped 项已一致，$missing 项缺失" -ForegroundColor Yellow
    Write-Host "去掉 -WhatIfOnly 实际执行。" -ForegroundColor Yellow
} else {
    Write-Host "完成：写入 $copied 项，跳过 $skipped 项" -ForegroundColor Green
    Write-Host ""
    Write-Host "下一步：重启 DSH（插件是 Node 模块，改文件不会热生效）" -ForegroundColor Cyan
    Write-Host "重启后应能看到「知识库」「技能库」两个页签。" -ForegroundColor Cyan
}
Write-Host ("-" * 60)
