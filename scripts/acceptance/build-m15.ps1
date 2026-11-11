# M15 受控构建命令（由 evidence.cjs build 以干净树调用）
# 前端三应用 turbo build + 后端 clean package 身份注入由 evidence.cjs 负责
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repoRoot

Set-Location schema-frontend
pnpm build
if ($LASTEXITCODE -ne 0) { Write-Error "前端构建失败 $LASTEXITCODE"; exit 1 }
Set-Location $repoRoot

Set-Location schema-platform
mvn -B -q clean install -DskipTests
if ($LASTEXITCODE -ne 0) { Write-Error "后端 install 失败 $LASTEXITCODE"; exit 1 }
mvn -B -q -pl bootstrap package spring-boot:repackage -DskipTests
if ($LASTEXITCODE -ne 0) { Write-Error "后端 package 失败 $LASTEXITCODE"; exit 1 }
Write-Output "M15_BUILD_OK"
