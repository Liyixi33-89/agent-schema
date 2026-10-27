# verify.ps1 - 三级验证管线（quick / commit / ci）
# 用法: pwsh scripts/verify.ps1 -Level quick|commit|ci   （Windows PowerShell 5.1 兼容）
# 原则: 环境结构性缺失时 [SKIP] 并说明兜底方，优于误导性失败（优雅降级）
# 防腐: 检查项动态扫描目录，禁止硬编码清单（新增项漏检 = 检查器腐烂）
param(
    [ValidateSet('quick', 'commit', 'ci')]
    [string]$Level = 'quick'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot | Split-Path
Set-Location $root

$script:steps = New-Object System.Collections.ArrayList
$script:failedCount = 0

function Record([string]$name, [string]$result, [string]$note, [long]$ms) {
    $h = @{ step = $name; result = $result; duration_ms = $ms }
    if ($note) { $h.note = $note }
    [void]$script:steps.Add($h)
}

function Step([string]$name, [scriptblock]$body) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $body
        Write-Host ("[PASS] {0} ({1}ms)" -f $name, $sw.ElapsedMilliseconds) -ForegroundColor Green
        Record $name 'PASS' $null $sw.ElapsedMilliseconds
    }
    catch {
        Write-Host ("[FAIL] {0}: {1}" -f $name, $_.Exception.Message) -ForegroundColor Red
        Record $name 'FAIL' $_.Exception.Message $sw.ElapsedMilliseconds
        $script:failedCount++
    }
}

function Skip([string]$name, [string]$reason) {
    Write-Host ("[SKIP] {0} -- {1}" -f $name, $reason) -ForegroundColor Yellow
    Record $name 'SKIP' $reason 0
}

function Finish() {
    param([string]$Level, [System.Diagnostics.Stopwatch]$swTotal)
    $swTotal.Stop()
    $overall = 'PASS'
    if ($script:failedCount -gt 0) { $overall = 'FAIL' }

    # 结果落账（度量不入 git；.gitignore 含 .agent/metrics/verify-log.jsonl）
    $logDir = Join-Path $root '.agent\metrics'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    $entry = @{
        ts            = (Get-Date -Format o)
        level         = $Level
        result        = $overall
        duration_ms   = $swTotal.ElapsedMilliseconds
        failed_steps  = $script:failedCount
        trigger       = 'manual'
        steps         = $script:steps
    } | ConvertTo-Json -Compress -Depth 4
    Add-Content -Path (Join-Path $logDir 'verify-log.jsonl') -Value $entry -Encoding UTF8

    Write-Host ''
    Write-Host ('===== verify[{0}] {1} ({2}ms) =====' -f $Level, $overall, $swTotal.ElapsedMilliseconds) -ForegroundColor $(if ($overall -eq 'FAIL') { 'Red' } else { 'Green' })
    if ($overall -eq 'FAIL') {
        Write-Host '红线：失败静默重试不得超过 2 次——换思路或上报（AGENTS.md §8）' -ForegroundColor Yellow
        exit 1
    }
    exit 0
}

# ============================================================
# 检查器实现
# ============================================================

function Test-DocAntiCorruption {
    $errs = New-Object System.Collections.ArrayList

    # 1) AGENTS.md 存在且 ≤200 行
    $agents = Join-Path $root 'AGENTS.md'
    if (-not (Test-Path $agents)) { [void]$errs.Add('AGENTS.md 缺失') }
    else {
        $lines = (Get-Content $agents | Measure-Object -Line).Lines
        if ($lines -gt 200) { [void]$errs.Add("AGENTS.md 超预算: $lines 行 (>200)") }
    }

    # 2) specs/ 与 skills/ 动态扫描：frontmatter 必填字段逐文件校验
    foreach ($dir in @('specs', 'skills')) {
        $base = Join-Path $root ".agent\$dir"
        if (-not (Test-Path $base)) { [void]$errs.Add(".agent/$dir 目录缺失"); continue }
        $files = @(Get-ChildItem $base -Filter '*.md' | Where-Object { $_.Name -notlike '_*' })
        $required = @{}
        if ($dir -eq 'specs') { $required = @{ spec_id = $true; status = $true } } else { $required = @{ name = $true; triggers = $true } }
        foreach ($f in $files) {
            # 取完整 frontmatter 块：首个 --- 到第二个 --- 之间（显式 UTF8，防 GBK 误解码）
            $lines = Get-Content $f.FullName -Encoding UTF8
            $fm = @()
            if ($lines.Count -gt 0 -and $lines[0].Trim() -eq '---') {
                for ($j = 1; $j -lt $lines.Count; $j++) {
                    if ($lines[$j].Trim() -eq '---') { break }
                    $fm += $lines[$j]
                }
            }
            if ($fm.Count -eq 0) { [void]$errs.Add("$($f.Name) 缺 YAML frontmatter"); continue }
            foreach ($key in $required.Keys) {
                $hit = $fm | Where-Object { $_ -match ("^\s*" + $key + "\s*:") }
                if (-not $hit) { [void]$errs.Add("$($f.Name) 缺 frontmatter 字段: $key") }
            }
        }
        if ($files.Count -eq 0) { [void]$errs.Add(".agent/$dir 无内容文件（模板除外）") }
    }

    # 3) 防腐词扫描：项目级文档禁止出现任务进度/实时状态类内容
    $scanTargets = @(Join-Path $root 'AGENTS.md')
    $scanTargets += @(Get-ChildItem (Join-Path $root '.agent') -Recurse -Filter '*.md' | ForEach-Object { $_.FullName })
    $banned = @('TODO:', 'FIXME:', '当前进度', '待办：')
    foreach ($f in $scanTargets) {
        $i = 0
        foreach ($line in (Get-Content $f -Encoding UTF8)) {
            $i++
            foreach ($b in $banned) {
                if ($line -like "*$b*") { [void]$errs.Add("$(Split-Path $f -Leaf):$i 含过期风险内容 '$b'") }
            }
        }
    }

    # 4) 起步模板仍在
    foreach ($t in @('.agent\specs\_template.md', '.agent\skills\_template.md')) {
        if (-not (Test-Path (Join-Path $root $t))) { [void]$errs.Add("模板缺失: $t") }
    }

    if ($errs.Count -gt 0) { throw ($errs -join '; ') }
}

# ============================================================
# quick 级
# ============================================================
$swTotal = [System.Diagnostics.Stopwatch]::StartNew()

Step 'doc-anti-corruption' { Test-DocAntiCorruption }

$fe = Join-Path $root 'schema-frontend'
$be = Join-Path $root 'schema-platform'

if (Test-Path (Join-Path $fe 'package.json')) {
    Step 'frontend-tsc' {
        if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm 未安装' }
        Push-Location $fe
        try { pnpm exec tsc --noEmit; if ($LASTEXITCODE -ne 0) { throw "tsc 退出码 $LASTEXITCODE" } }
        finally { Pop-Location }
    }
} else { Skip 'frontend-tsc' 'schema-frontend 尚未初始化（spec-001 落地后生效）' }

if (Test-Path (Join-Path $be 'pom.xml')) {
    Step 'backend-compile' {
        Push-Location $be
        try { mvn -q compile "-DskipTests"; if ($LASTEXITCODE -ne 0) { throw "mvn 退出码 $LASTEXITCODE" } }
        finally { Pop-Location }
    }
} else { Skip 'backend-compile' 'schema-platform 尚未初始化' }

if ($Level -eq 'quick') { Finish -Level $Level -swTotal $swTotal }

# ============================================================
# commit 级
# ============================================================
if (Test-Path (Join-Path $fe 'package.json')) {
    Step 'frontend-build' {
        Push-Location $fe
        try { pnpm build; if ($LASTEXITCODE -ne 0) { throw "build 退出码 $LASTEXITCODE" } }
        finally { Pop-Location }
    }
    Step 'frontend-test' {
        Push-Location $fe
        try { pnpm test -- --run; if ($LASTEXITCODE -ne 0) { throw "test 退出码 $LASTEXITCODE" } }
        finally { Pop-Location }
    }
} else { Skip 'frontend-build/test' 'schema-frontend 尚未初始化' }

if (Test-Path (Join-Path $be 'pom.xml')) {
    Step 'backend-test' {
        Push-Location $be
        try { mvn -q test; if ($LASTEXITCODE -ne 0) { throw "mvn test 退出码 $LASTEXITCODE" } }
        finally { Pop-Location }
    }
} else { Skip 'backend-test' 'schema-platform 尚未初始化' }

# commit 通过后：刷新 active spec 的 last_verified_at（活文档闭环）
# 读写均显式 UTF8；写回用 .NET WriteAllText 保持无 BOM（PS5.1 的 Set-Content -Encoding UTF8 会加 BOM）
if ($script:failedCount -eq 0) {
    Get-ChildItem (Join-Path $root '.agent\specs') -Filter '*.md' |
        Where-Object { $_.Name -notlike '_*' } | ForEach-Object {
            $raw = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
            if ($raw -match 'status:\s*active') {
                $raw = $raw -replace 'last_verified_at:\s*\S*', ('last_verified_at: ' + (Get-Date -Format 'yyyy-MM-dd'))
                $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
                [System.IO.File]::WriteAllText($_.FullName, $raw, $utf8NoBom)
            }
        }
}

if ($Level -eq 'commit') { Finish -Level $Level -swTotal $swTotal }

# ============================================================
# ci 级
# ============================================================
if (Test-Path (Join-Path $fe 'playwright.config.ts')) {
    Step 'frontend-e2e' {
        Push-Location $fe
        try { pnpm exec playwright test; if ($LASTEXITCODE -ne 0) { throw "e2e 退出码 $LASTEXITCODE" } }
        finally { Pop-Location }
    }
} else { Skip 'frontend-e2e' 'Playwright 未配置（E2E 链路任务落地后生效）' }

Finish -Level $Level -swTotal $swTotal
