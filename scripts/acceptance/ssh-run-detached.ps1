# SSH 分离执行器（accept-lib sshDbQuery 专用）：
# 终端管控环境下 Node 进程树内 spawn ssh 全部 ETIMEDOUT——经 Start-Process 分离
# 进程执行 ssh 一次性命令（与常驻隧道同机制，不受拦截），结果文件回传。
param(
  [Parameter(Mandatory=$true)][string]$RemoteCmd,
  [Parameter(Mandatory=$true)][string]$KeyPath,
  [Parameter(Mandatory=$true)][string]$SshHost,
  [Parameter(Mandatory=$true)][string]$OutFile
)
$ErrorActionPreference = 'Stop'
if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
$sshArgs = @('-i', $KeyPath, '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes', "root@$SshHost", $RemoteCmd)
$escaped = $sshArgs | ForEach-Object {
  if ($_ -match '[\s"&|<>]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
}
$full = 'ssh ' + ($escaped -join ' ') + ' > "' + $OutFile + '" 2>&1'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $full -WindowStyle Hidden -Wait
if (Test-Path $OutFile) { Get-Content $OutFile -Raw }
