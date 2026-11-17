# T7/T9 验收面与隧道处置记录（2026-11-17）

> 定位：spec 016 §T7（驻留决策）/ §T9（服务器配置变更执行）收口——M15 遗留开放项的最终处置。
> 执行窗口：2026-11-17 14:41-14:45（UTC+8）；执行脚本：`/opt/schema/staging/t9-execute.sh`（服务器留存）；执行日志：`/opt/schema/staging/t9-execution.log`。

## 1. 裁决结论（human-lead 指令「执行」授权处置）

| 项 | 处置 | 理由 |
|---|---|---|
| `/accept/` 验收面（80 端口 nginx 反代） | **保留** | G1-G7 上线核对仍需引用验收面证据链；验收库 schema_acceptance（53 表）是 DR 演练比对真源；保留面已有完整安全头基线（nosniff/Referrer-Policy/XFO/CSP）且走统一入口 |
| 隧道通道（schema-accept-tunnel.conf / 18082） | **清理下线** | M15 验收期临时通道（办公网 80 拦截规避），验收已收口且隧道进程早已不存在；配置仅本机监听无业务依赖 |
| 攻击探针（schema-accept-security.conf / 18097 `/attack.js`） | **清理下线** | M15 CSP 验收专用角色资源，SEC-A3/A6 用例已 PASS 归档；公网可达的攻击模拟资源不应驻留 |
| 验收后端 18081 监听面 | **收敛为 127.0.0.1** | 原 `*:18081` 公网直连绕过 nginx 头基线与 Origin 面收窄；收敛后仅留 80 反代唯一通道（与生产 18080 同等面管控语义） |

**不变项**：生产 18080（systemd `schema-platform`）全程未动（执行前后探活 active/401 一致）；数据库未动（schema_acceptance/schema_prod 及备份链路保持原样）；`/accept/` 静态目录与验收 jar 未动。

## 2. 执行步骤与证据

1. **备份先行**：三份 nginx 配置 + 18081 原启动命令行 → `/opt/schema/backups/nginx-config-bak-20261117-144156/`（含 disabled- 前缀的已下线配置，可原样恢复）
2. **配置下线**：`schema-accept-tunnel.conf`、`schema-accept-security.conf` 移入备份目录（非删除）；`nginx -t` 通过后 `systemctl reload nginx`（18082/18097 端口关闭）
3. **18081 收敛**：旧进程（`*:18081`，pid 1826170）停止 → 同 jar 同库同端口重启，新增 `--server.address=127.0.0.1` → 监听态 `[::ffff:127.0.0.1]:18081`；启动日志 `Started SchemaApplication in 4.479s`
4. **终态核对**（公网侧实测）：
   - `/accept/` 前端：**200**（保留 ✓）
   - `/accept/api/auth/csrf`、登录：**200**（反代链路完好 ✓）
   - 直连 `18081`：**000 连接超时**（公网不可达 ✓）
   - 直连 `18097/attack.js`：**000 连接超时**（探针已下线 ✓）
   - 主站 80：**200**（生产未受影响 ✓）
   - 本机 `18081` 探活：401（鉴权拒绝=存活语义）；`ss` 确认 18082/18097 无监听
5. **全链路业务验证**（Node fetch + 手工 cookie jar，三步）：csrf 200 → login 200（`schema_at`/`schema_rt` 签发）→ 数据查询 200（`{"list":[],"total":0}`）——验收面经 80 入口端到端可用

## 3. 回滚路径

```bash
# 恢复隧道/探针配置
cp /opt/schema/backups/nginx-config-bak-20261117-144156/disabled-*.conf /etc/nginx/conf.d/
nginx -t && systemctl reload nginx
# 恢复 18081 公网监听（如需）
# 按 accept-backend-cmdline-before.txt 原命令行重启（去掉 --server.address 参数）
```

## 4. 残留清理项（不影响本处置完整性）

- 服务器 `/opt/schema/staging/` 下历史演练产物（perf/、dr-drill*/、fault-drill*/ 等）为证据留存目录，**不清理**——G1-G7 引用
- `deploy-sla-18081.sh` 等验收后端运维脚本保留（18081 服务仍在用，只是监听面收敛）
- M15 台账 open findings「公网验收面长期驻留」「隧道 nginx 配置收尾清理」随本记录闭环
