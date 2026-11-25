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
    # 关联信息（第二阶段）：被测代码 SHA / 运行编号 / 环境——便于跨轮追溯
    $commitSha = ''
    try { $commitSha = (git rev-parse HEAD 2>$null | Select-Object -First 1) } catch { $commitSha = '' }
    $nodeVer = ''
    try { $nodeVer = (node --version 2>$null | Select-Object -First 1) } catch { $nodeVer = '' }
    $javaVer = ''
    try { $javaVer = (java -version 2>&1 | Select-Object -First 1) } catch { $javaVer = '' }
    $entry = @{
        ts            = (Get-Date -Format o)
        level         = $Level
        result        = $overall
        commit        = $commitSha
        run_id        = $env:GITHUB_RUN_ID
        env           = @{
            os       = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
            node     = $nodeVer
            java     = $javaVer
        }
        duration_ms   = $swTotal.ElapsedMilliseconds
        failed_steps  = $script:failedCount
        trigger       = $(if ($env:GITHUB_ACTIONS -eq 'true') { 'ci' } elseif ($env:AGENT_SESSION) { 'agent' } else { 'manual' })
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
        if ($dir -eq 'specs') { $required = @{ spec_id = $true; status = $true; milestone = $true } } else { $required = @{ name = $true; triggers = $true } }
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

    # 4) 编码完整性：GBK 读 + UTF-8 写的典型乱码特征（实证 2026-10-27 spec-001 被污染）
    #    扫描 AGENTS.md、.agent、docs、scripts 全部文本；.ps1 额外要求 UTF-8 BOM（PS5.1 无 BOM 按 GBK 解码）
    #    特征字用 \u 转义书写，避免检查器自身命中
    $mojibake = '([\u9366\u9428\u951B\u93C4\u6D93\u93BA\u5997\u5A34\u9418\u947C\u922B\u9286])'
    $encTargets = @(Join-Path $root 'AGENTS.md')
    foreach ($d in @('.agent', 'docs', 'scripts', '.github')) {
        $dp = Join-Path $root $d
        if (Test-Path $dp) {
            $encTargets += @(Get-ChildItem $dp -Recurse -File -Include '*.md', '*.ps1', '*.yml' | ForEach-Object { $_.FullName })
        }
    }
    foreach ($f in $encTargets) {
        $bytes = [System.IO.File]::ReadAllBytes($f)
        $text = [System.Text.Encoding]::UTF8.GetString($bytes)
        if ($text -match $mojibake) { [void]$errs.Add("$(Split-Path $f -Leaf) 疑似编码污染（命中 '$($Matches[1])'）") }
        if ($f -like '*.ps1' -and -not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)) {
            [void]$errs.Add("$(Split-Path $f -Leaf) 缺 UTF-8 BOM（PS5.1 将按 GBK 解码）")
        }
    }

    # 5) 死引用：文档中引用的 skills/<name> 必须真实存在
    $skillNames = @(Get-ChildItem (Join-Path $root '.agent\skills') -Filter '*.md' | ForEach-Object { $_.BaseName })
    foreach ($f in ($scanTargets | Where-Object { (Split-Path $_ -Leaf) -notlike '_*' })) {
        $c = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
        foreach ($m in [regex]::Matches($c, 'skills/([a-z0-9][a-z0-9-]+)')) {
            $n = $m.Groups[1].Value
            if ($skillNames -notcontains $n) { [void]$errs.Add("$(Split-Path $f -Leaf) 引用不存在的 skill: $n") }
        }
    }

    # 6) 起步模板仍在
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
        try { pnpm typecheck; if ($LASTEXITCODE -ne 0) { throw "typecheck 退出码 $LASTEXITCODE" } }
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

$contractDir = Join-Path $fe 'packages\schema-protocol\contract'
if (Test-Path $contractDir) {
    Step 'contract-diff' {
        # M1.5 枚举专项 diff（评审稿 §7.3 遗留项闭环）：
        # 前端 export:enums 生成 contract/export/enums.json（唯一真源）
        # → 后端 EnumContractTest 逐组比对 Java 枚举与前端导出（漂移即 FAIL）
        # 完整 zod→json-schema 结构 diff 随 M1.5 后续批次点亮（spec-001 T6）
        Push-Location $fe
        try {
            pnpm --filter @schema/schema-protocol run export:enums
            if ($LASTEXITCODE -ne 0) { throw "前端枚举导出退出码 $LASTEXITCODE" }
            pnpm --filter @schema/schema-protocol run export:schema
            if ($LASTEXITCODE -ne 0) { throw "前端结构导出退出码 $LASTEXITCODE" }
        } finally { Pop-Location }
        $enumsJson = Join-Path $contractDir 'export\enums.json'
        if (-not (Test-Path $enumsJson)) { throw "枚举导出文件缺失: $enumsJson" }
        $schemaJson = Join-Path $contractDir 'export\schema.json'
        if (-not (Test-Path $schemaJson)) { throw "结构导出文件缺失: $schemaJson" }
        Push-Location $be
        try {
            mvn -q -pl schema-protocol test "-Dtest=EnumContractTest,SchemaContractTest"
            if ($LASTEXITCODE -ne 0) { throw "后端契约比对退出码 $LASTEXITCODE" }
            # M14 红线双端同判（08FE §8）：后端 Node 工脚本跑共享 redline-vectors.json，
            # 判定必须与前端 Vitest 一致（漂移即 FAIL）；Node 不可用时 FAIL 不降级（红线门禁不可跳）
            $buildMod = Join-Path $be 'build-module'
            if (Test-Path (Join-Path $buildMod 'pom.xml')) {
                if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node 不可用——红线同判门禁不可跳过' }
                # -am 带兄弟模块（SNAPSHOT 未装仓时 -pl 单跑依赖解析失败——M12 已沉淀同款坑）
                mvn -q -pl build-module -am test "-Dtest=RedlineVectorTest" "-Dsurefire.failIfNoSpecifiedTests=false"
                if ($LASTEXITCODE -ne 0) { throw "红线向量同判退出码 $LASTEXITCODE" }
            }
        } finally { Pop-Location }
    }
} else { Skip 'contract-diff' 'contract/ 尚未导出（spec-001 T6 落地后生效）' }

# ============================================================
# quick 级（附加）：验收/证据工具自测 —— 自动发现 scripts 下全部 *.test.cjs
# 工具自身必须可复验（run-id 隔离/归档/校验门禁防腐化）
# ============================================================
$toolTests = @(Get-ChildItem (Join-Path $root 'scripts') -Recurse -Filter '*.test.cjs' | ForEach-Object { $_.FullName })
if ($toolTests.Count -gt 0) {
    Step 'tools-selftest' {
        foreach ($t in $toolTests) {
            Write-Host ("-- {0}" -f (Split-Path $t -Leaf))
            node --test $t
            if ($LASTEXITCODE -ne 0) { throw "$(Split-Path $t -Leaf) 自测退出码 $LASTEXITCODE" }
        }
        Write-Host ("工具自测: {0} 个套件全过" -f $toolTests.Count)
    }
    # 冒烟门禁自测（P0 消除假绿）：喂合成 stats 验证「缺统计/零用例/必跑失败」都会变红。
    # 独立于 node --test（该脚本是命令式断言，不走测试协议）。
    $smokeGate = Join-Path $root 'scripts\acceptance\smoke-gate.test.cjs'
    if (Test-Path $smokeGate) {
        Step 'smoke-gate-selftest' {
            node $smokeGate
            if ($LASTEXITCODE -ne 0) { throw "冒烟门禁自测退出码 $LASTEXITCODE（门禁可能已退化）" }
        }
    }
} else { Skip 'tools-selftest' '未发现 *.test.cjs（scripts 下）' }

Step 'python-tools-selftest' {
    $tests = @(Get-ChildItem (Join-Path $root 'scripts') -Filter '*_test.py' | Where-Object { $_.Name -ne 'workflow_gate_test.py' })
    if ($tests.Count -eq 0) { throw '未发现 Python 工具回归测试' }
    foreach ($test in $tests) {
        $raw = & python -c 'import runpy,sys,os; sys.stderr=sys.stdout; path,name=sys.argv[1:]; sys.argv=[path]; sys.path.insert(0,os.path.dirname(os.path.abspath(path))); runpy.run_path(path,run_name=name)' $test.FullName '__main__'
        $code = $LASTEXITCODE
        $raw | ForEach-Object { Write-Host $_ }
        if ($code -ne 0) { throw "$($test.Name) 自测退出码 $code" }
    }
}

# 台账门禁真实测试（临时 Git 仓库 + 真实 CLI）：verify_commit/audit 拒绝路径
# 注意：python 把进度写 stderr（PowerShell 已知误报源），退出码必须从 $global:LASTEXITCODE 取
$workflowGateTest = Join-Path $root 'scripts\workflow_gate_test.py'
if (Test-Path $workflowGateTest) {
    Step 'workflow-gate-test' {
        # 在 Python 内统一输出通道，兼容 PS5.1 与 Linux，保留真实退出码
        $raw = & python -c 'import runpy,sys,os; sys.stderr=sys.stdout; path,name=sys.argv[1:]; sys.argv=[path]; sys.path.insert(0,os.path.dirname(os.path.abspath(path))); runpy.run_path(path,run_name=name)' $workflowGateTest '__main__'
        $code = $global:LASTEXITCODE
        $hasOk = ($raw -split "`r?`n" | Where-Object { $_ -match '^(OK|FAILED\b)' }) -join '; '
        if ($code -ne 0 -or $hasOk -notmatch 'OK') { throw "workflow 门禁测试未通过 (exit=$code) :: $hasOk" }
        Write-Host ("台账门禁测试: {0}" -f $hasOk)
    }
} else { Skip 'workflow-gate-test' 'workflow_gate_test.py 不存在' }

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
    Step 'frontend-test-types' {
        Push-Location $fe
        try {
            pnpm exec tsc -p tsconfig.tests.json
            if ($LASTEXITCODE -ne 0) { throw "测试代码类型检查退出码 $LASTEXITCODE" }
        } finally { Pop-Location }
    }
    Step 'frontend-test' {
        Push-Location $fe
        try {
            # CI 环境启用 junit reporter（vitest.config.ts 按 process.env.CI 切换）
            $env:CI = 'true'
            pnpm run test; if ($LASTEXITCODE -ne 0) { throw "test 退出码 $LASTEXITCODE" }
        }
        finally { Pop-Location }

        # 报告核对（第二阶段）：拒绝「无报告 / 零用例」——与 backend-it 的 Surefire 核对同口径
        $xmlPath = Join-Path $fe 'vitest-report.xml'
        if (-not (Test-Path $xmlPath)) {
            throw "vitest 报告缺失: $xmlPath（junit reporter 未生效——检查 vitest.config.ts 与 CI 环境变量）"
        }
        $doc = New-Object System.Xml.XmlDocument
        $doc.Load($xmlPath)
        # junit 根为 <testsuites>，其子节点为各测试文件 <testsuite>
        $suiteNodes = @($doc.DocumentElement.SelectNodes('testsuite'))
        $total = 0; $failures = 0; $errors = 0; $skipped = 0
        foreach ($s in $suiteNodes) {
            $total += [int]$s.GetAttribute('tests')
            $failures += [int]$s.GetAttribute('failures')
            $errors += [int]$s.GetAttribute('errors')
            $skipped += [int]$s.GetAttribute('skipped')
        }
        $passed = $total - $failures - $errors - $skipped
        Write-Host ("  vitest: files={0} tests={1} passed={2} failed={3} errors={4} skipped={5}" -f $suiteNodes.Count, $total, $passed, $failures, $errors, $skipped)
        if ($suiteNodes.Count -eq 0) { throw "vitest 零测试文件（报告为空——测试发现规则可能失效）" }
        if ($total -eq 0) { throw "vitest 零用例（报告 tests=0——必验项不得空跑）" }
        if ($skipped -gt 0) {
            # 跳过不直接判失败（有合法 skip 场景），但必须在日志中显式暴露
            Write-Host "  [WARN] 存在 $skipped 个跳过用例——审查是否属必验项" -ForegroundColor Yellow
        }
    }
} else { Skip 'frontend-build/test' 'schema-frontend 尚未初始化' }

if (Test-Path (Join-Path $be 'pom.xml')) {
    Step 'backend-test' {
        Push-Location $be
        try { mvn -q test; if ($LASTEXITCODE -ne 0) { throw "mvn test 退出码 $LASTEXITCODE" } }
        finally { Pop-Location }
    }
    # M2/M3 集成测试门禁（01BE §7 / 03BE §7 硬性要求：真实 PG）：引擎就绪才执行，缺环境降级说明
    # 数据源注入链：IT 已参数化为 ${IT_DB_HOST}:${IT_DB_PORT}/${IT_DB_NAME}（占位符解析优先级
    # 系统属性 > 环境变量 > 默认值）——隧道/WSL 场景改 VERIFY_IT_DB_* 即可，无需改代码
    Step 'backend-it' {
        $pgHost = $env:VERIFY_IT_DB_HOST; if (-not $pgHost) { $pgHost = $env:VERIFY_PG_HOST }
        if (-not $pgHost) { $pgHost = 'localhost' }
        $pgPort = $env:VERIFY_IT_DB_PORT; if (-not $pgPort) { $pgPort = '5432' }
        $pgDb = $env:VERIFY_IT_DB_NAME; if (-not $pgDb) { $pgDb = 'schema_dev' }
        $pgUser = $env:VERIFY_IT_DB_USER; if (-not $pgUser) { $pgUser = 'schema_dev' }
        $pgPass = $env:VERIFY_IT_DB_PASS; if (-not $pgPass) { $pgPass = 'schema_local_only' }
        $pgUp = $false
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $tcp.Connect($pgHost, [int]$pgPort)
            $pgUp = $true
            $tcp.Close()
        } catch { $pgUp = $false }
        if (-not $pgUp) { throw "PG 未就绪（${pgHost}:${pgPort}）——集成测试门禁不可跳过（本地 docker compose up -d postgres；或经 VERIFY_IT_DB_* 指向隧道端点）" }

        # 自动发现执行清单：扫描 *IT.java（防腐：新增 IT 漏登命令 = 门禁腐烂）
        $itDir = Join-Path $be 'bootstrap\src\test\java\com\schema\bootstrap'
        $itFiles = @(Get-ChildItem $itDir -Filter '*IT.java' | ForEach-Object { $_.BaseName })
        if ($itFiles.Count -eq 0) { throw "未发现任何 *IT.java（目录: $itDir)" }
        $itList = ($itFiles -join ',')

        $itStartedAt = (Get-Date).ToUniversalTime()
        Push-Location $be
        try {
            # -am 连带构建依赖模块；-Dsurefire.failIfNoSpecifiedTests=false：依赖模块（platform-common 等）
            # 无匹配 IT 属预期，真漏跑由下方 Surefire 报告核对兜底（bootstrap 模块每个 IT 必须有非零用例报告）
            # stderr 双保险（PS5.1 坑）：2> $null 重定向在 ErrorActionPreference='Stop' 下仍会把 stderr 首行
            # （Mockito/byte-buddy self-attaching WARNING）包装成 NativeCommandError 抛出——调用期间临时放宽
            # EAP，真实结论以退出码 + Surefire 报告核对为准
            $prevEap = $ErrorActionPreference
            $ErrorActionPreference = 'Continue'
            mvn -q -pl bootstrap -am test "-Dtest=$itList" '-Dsurefire.failIfNoSpecifiedTests=false' `
                "-Dit.db.host=$pgHost" "-Dit.db.port=$pgPort" "-Dit.db.name=$pgDb" `
                "-Dit.db.user=$pgUser" "-Dit.db.pass=$pgPass" `
                "-DIT_DB_HOST=$pgHost" "-DIT_DB_PORT=$pgPort" "-DIT_DB_NAME=$pgDb" `
                "-DIT_DB_USER=$pgUser" "-DIT_DB_PASS=$pgPass" 2> $null
            $mvnItExit = $LASTEXITCODE
            $ErrorActionPreference = $prevEap
            if ($mvnItExit -ne 0) { throw "集成测试退出码 $mvnItExit（PowerShell 下 mvn/git 把进度写 stderr 是误报来源；真实结论看 BUILD SUCCESS/测试计数）" }
        } finally {
            if ($null -ne $prevEap) { $ErrorActionPreference = $prevEap }
            Pop-Location
        }

        # 执行后核对：每个预期 IT 必须有 Surefire 报告且测试数 > 0（防"指定测试不存在"静默漏跑）
        $reportDir = Join-Path $be 'bootstrap\target\surefire-reports'
        $missing = @(); $zero = @()
        foreach ($it in $itFiles) {
            $xml = Join-Path $reportDir ("TEST-com.schema.bootstrap.{0}.xml" -f $it)
            if (-not (Test-Path $xml)) { $missing += $it; continue }
            if ((Get-Item $xml).LastWriteTimeUtc -lt $itStartedAt) { $missing += "$it(旧报告)"; continue }
            [xml]$report = Get-Content $xml -Raw -Encoding UTF8
            $suite = $report.DocumentElement
            # ⚠️ Surefire 的根节点名是**测试类全名**（如 com.schema.bootstrap.XxxIT），
            #    不是 'testsuite'——不能按字面量比对，否则每个 IT 都被判成零用例。
            #    这里只校验根节点带 tests/failures/errors/skipped 四属性即可。
            if ($null -eq $suite.GetAttribute('tests')) { $missing += "$it(报告结构异常)"; continue }
            $tests = [int]$suite.GetAttribute('tests')
            $failures = [int]$suite.GetAttribute('failures')
            $errors = [int]$suite.GetAttribute('errors')
            $skipped = [int]$suite.GetAttribute('skipped')
            if ($tests -le 0 -or $tests -le $skipped) { $zero += $it }
            if ($failures -gt 0 -or $errors -gt 0 -or $skipped -gt 0) { $missing += "$it(失败或跳过)" }
        }
        if ($missing.Count -gt 0 -or $zero.Count -gt 0) {
            $detail = @()
            if ($missing.Count -gt 0) { $detail += ("缺执行报告: " + ($missing -join ', ')) }
            if ($zero.Count -gt 0) { $detail += ("零用例: " + ($zero -join ', ')) }
            throw ("集成测试执行核对 FAIL: " + ($detail -join '; '))
        }
        Write-Host ("集成测试执行核对: {0} 个 IT 全部有非零用例报告" -f $itFiles.Count)
    }
} else { Skip 'backend-test/backend-it' 'schema-platform 尚未初始化' }

# 验证日期纪律（M16 门禁修正）：门禁通过只证明「代码当前可验证」，
# 不代表全部 active spec 的专项实测已完成——日期刷新权留给真实专项验证（验收套件/实测记录）。
# 此处仅将代码级检查记录进验证日志（.agent/metrics/verify-log.jsonl，上面已落账）。

if ($Level -in @('commit', 'ci')) {
    # ============================================================
    # commit/ci：正式归档完整性——每个带 manifest 的归档必须过 check
    # 历史 legacy 目录无 manifest（规范：不补造），不在本步骤范围
    # ============================================================
    $archRoot = Join-Path $root 'docs\acceptance'
    $manifests = @(Get-ChildItem $archRoot -Recurse -Filter 'manifest.json' -ErrorAction SilentlyContinue)
    if ($manifests.Count -eq 0) {
        Skip 'acceptance-archives' '暂无新协议归档（全是历史 legacy；首个 run-id 归档后本步骤自动生效）'
    } else {
        Step 'acceptance-archives' {
            foreach ($m in $manifests) {
                # PS5.1 的 .NET Framework 无 Path.GetRelativePath（PS7 专有）——手动截前缀兼容双版本
                $rel = $m.DirectoryName.Substring($archRoot.Length).TrimStart('\', '/')
                node (Join-Path $root 'scripts\acceptance\evidence.cjs') check $rel
                if ($LASTEXITCODE -ne 0) { throw "归档校验 FAIL: $rel" }
            }
            Write-Host ("归档完整性: {0} 个 manifest 全部 PASS" -f $manifests.Count)
        }
    }
    if ($Level -eq 'commit') { Finish -Level $Level -swTotal $swTotal }
}

# ============================================================
# ci 级
# ============================================================
# 日常浏览器冒烟 = Playwright（与 .github/workflows/smoke.yml 同一个入口）。
# - 这是唯一必过入口；旧的 CDP smoke-all.cjs 已从日常门禁移除
#   （scripts/acceptance 下的 CDP 脚本保留，供专项验收使用）。
# - 环境前提必须显式声明，缺失即失败——不静默跳过、不回退公网：
#     SMOKE_DESIGNER_BASE / SMOKE_RUNTIME_BASE / SMOKE_ADMIN_BASE  三应用地址（含 base 前缀）
#     SMOKE_META_FILE                                             种子元数据（appId/pageId/title）
#     SMOKE_USERNAME / SMOKE_PASSWORD                             隔离 CI 账号
$pwConfig = Join-Path $fe 'playwright.config.ts'
if (Test-Path $pwConfig) {
    Step 'frontend-smoke' {
        foreach ($v in @('SMOKE_DESIGNER_BASE', 'SMOKE_RUNTIME_BASE', 'SMOKE_ADMIN_BASE', 'SMOKE_META_FILE', 'SMOKE_USERNAME', 'SMOKE_PASSWORD')) {
            $val = [Environment]::GetEnvironmentVariable($v)
            if ([string]::IsNullOrWhiteSpace($val)) {
                throw "$v 未设置——ci 级冒烟要求显式声明隔离测试栈（不静默跳过/不回退公网）"
            }
        }
        if (-not (Test-Path $env:SMOKE_META_FILE)) {
            throw "SMOKE_META_FILE 指向的文件不存在: $env:SMOKE_META_FILE（种子步骤未完成）"
        }
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node 不可用——浏览器冒烟不可跳过' }

        Push-Location $fe
        try {
            $env:CI = 'true'
            $playwrightStartedAt = ((Get-Date).ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds.ToString([Globalization.CultureInfo]::InvariantCulture)
            pnpm exec playwright test --config playwright.config.ts
            if ($LASTEXITCODE -ne 0) { throw "Playwright 退出码 $LASTEXITCODE" }
        }
        finally { Pop-Location }

        # 必跑场景核对（与 CI 同口径：缺报告/缺场景/跳过/失败 一律失败）
        $report = Join-Path $fe 'e2e-report.xml'
        if (-not (Test-Path $report)) { throw "Playwright 报告缺失: $report" }
        python (Join-Path $root 'scripts\test_gate.py') playwright $report --not-before $playwrightStartedAt
        if ($LASTEXITCODE -ne 0) { throw 'Playwright 报告核对失败' }
    }
} else { Skip 'frontend-smoke' 'playwright.config.ts 不存在' }

Finish -Level $Level -swTotal $swTotal
