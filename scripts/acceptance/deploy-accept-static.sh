# M13 验收面受控部署（designer 静态）
# 形态：Windows 分步执行（WSL 内 ssh/scp 连服务器不通——实测 exit 1，隧道由 Windows 侧持有）
# 步骤：
#   1) 本地受控构建：cd schema-frontend && pnpm --filter designer build
#   2) 记录本地哈希：(Get-FileHash -Algorithm SHA256 schema-frontend\apps\designer\dist\index.html).Hash.ToLower()
#   3) 上传：ssh ... root@111.231.57.177 "mkdir -p /tmp/accept-deploy"
#      scp ... -r schema-frontend/apps/designer/dist/* root@111.231.57.177:/tmp/accept-deploy/
#   4) 服务器端原子替换（server-deploy.sh 逻辑）：
#      - 哈希核对（传输防损）→ 备份旧版 → rm+mv 原子替换 → 探活 200 → 部署面哈希复核
#   5) 复核：本地哈希 == 上传哈希 == 部署面响应哈希 三点一致
# 约束：上传前后哈希核对；旧版本备份；部署后探活；全程无手填哈希。
# （完整服务器端脚本见本文件同目录 server-deploy 逻辑；此前单文件 bash 版在 WSL 不可用，保留此说明形态）
