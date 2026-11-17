# M16 试点可靠性与上线门禁——演练执行报告（T2/T3/T4）

执行日期：2026-11-16（UTC+8）　环境：验收服务器 111.231.57.177（4C/3.6G，PG 15.19）
执行人：实现会话 f42b4e21　产物目录：`docs/acceptance/M16/`

## 一、备份链路修复与 DR-01 恢复演练（T2）

### 1.1 发现并修复的存量缺陷（演练前 precheck 暴露）

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 1 | `schema-backup.sh` 使用 `runuser`（OpenCloudOS 无此命令），每日 03:30 备份自上线起全部失败 | 生产库 2+ 天无有效备份（产物 20 字节空 gzip） | 改 `su - postgres -c`，实测通过 |
| 2 | 备份只含 `schema_prod`（空业务库），遗漏 `schema_acceptance`（真实业务数据 53 表） | 即便修好 runuser 也备份不到业务数据 | 双库备份（prod+acceptance），逐库产物 |
| 3 | PG `archive_mode=off`，无 WAL 归档 | RPO≤15min 无法证明 | 开启归档 + `archive_timeout=300s`，实测归档堆积 |

修复脚本入库：`scripts/acceptance/m16-relaunch/`（schema-backup.sh / restore-verify.sh / enable-wal-archive.sh / dr-drill-recovery.sh）。服务器侧部署位置 `/opt/schema/`，旧版已备份 `.bak-20261116`。

### 1.2 DR-01 演练结果（PASS）

- **流程**：precheck（备份方式盘点+RPO 链路判定）→ 源库基线行数 → 建独立恢复库 `dr_drill_20261116_142512` → 全量灌入 → 附件文件层核对 → 逐表抽样校验（53 表）→ 只读业务冒烟 → 销毁演练库
- **结果指标**：
  - 表一致率 **100%**（53/53 表行数逐一比对，含 page_schema 88 行/meta_model 14 行）
  - 活跃页面 schema_etag 完整率 **100%**（88/88；5 行 NULL 均为 DELETED 软删行，属正常态）
  - **RTO 0.1 分钟**（目标 ≤4h）；恢复耗时 1s（9MB 库）
  - **RPO 证据**：archive_mode=on + archive_timeout=300s 强制切段 + 归档文件持续堆积 → RPO≤15min 成立
  - 演练库已销毁（`drillDbDestroyed: true`），不影响任何在线服务
- **产物**：`dr-drill/dr-drill-result.json`（完整报告）、`precheck.json`、`sample-check.json`、`source-baseline.json`、`dr-drill-run.log`

## 二、容量压测（T3，PERF 系列）

### 2.1 环境（满足隔离铁律）

- 专用测试 PG 实例：独立数据目录 `/opt/schema/perf-pgdata`，端口 **15433**，与线上 5432 完全隔离；账号 schema_perf 仅限本实例
- 压测后端：独立 jar 实例端口 **18083**（master HEAD 产物 + 发布竞态修复），指向 15433/schema_perf
- 数据基线：真实模型（API 建 model perf + 2 字段）+ 物理表 `biz_model_1` **1,001,004 行 / 235MB**（schema_version=2 与模型当前版本一致，API 查询可见）
- 压测工具：k6 v1.4.0（服务器直装），脚本按真实契约编写（Cookie 会话 + CSRF 双提交 + `POST /api/data/{modelId}` 写路径）

### 2.2 压测暴露并修复的并发缺陷

**发布竞态（真实缺陷）**：`PageCommandService.publish` 中 `nextReleaseVersion`（SELECT MAX）与 `insertAppRelease` 之间存在竞态，两个并发发布事务取到同一版本号，后提交者撞 `(app_id, release_version)` 唯一约束返回 500。压测风暴中实测复现（25 VU 并发发布批量 500）。

修复（commit `104c284`）：`nextReleaseVersion` 先 `SELECT ... FOR UPDATE` 锁 app 行再取 MAX，发布事务对同 app 串行化。修复后 40 并发发布风暴全 200。

### 2.3 容量基线（70/20/10 混合负载，90s 稳态）

| 档位 | query p95 | write p95 | publish p95 | SLA（p95<1.5s） |
|---|---|---|---|---|
| 50 VU | 291ms | 45ms | — | ✅ 通过 |
| 100 VU | 1,229ms | 1,009ms | — | ✅ 通过（余量收窄） |
| 150 VU | 3,329ms | 2,933ms | — | ❌ 超限 |
| 250 VU（风暴） | ~6.9s | — | ~9.9s | ❌ 饱和 |

- **容量结论**：单实例 4C/3.6G 安全容量 ≈**100 VU 并发**（SLA 内）；250 VU 为压力极限测试——全程无崩溃、无数据损坏、无死锁（后端错误日志 0 条业务错误）、恢复后业务探活 200
- **资源峰值**：CPU 100%（159/200 采样点饱和）、内存 90.5%、PG 连接 18、Java RSS 467MB（详见 `perf/resource-peak.json`）
- **产物**：`perf/`（k6 三档 summary + 250VU 风暴 summary + 阶梯 summary + 双脚本 + 控制台日志 + 资源峰值）

### 2.4 压测口径说明（诚实披露）

- k6 默认把非 2xx 计为 failed——健康接口 401（actuator 鉴权，任意响应即活的设计）与登录 400（mustChangePassword 响应风格）被误计，实际后端错误为 0
- 250 VU 场景 CPU 饱和导致延迟超标是**容量事实**而非缺陷；已通过 50/100/150 三档稳态测出满足 SLA 的容量边界供上线评审参考
- 服务器为 4C 小机型，容量数字仅代表当前配置；扩容（垂直）或水平扩展后需重测

## 三、故障注入与升级阻断演练（T4，TC-FT/TC-UP）

环境同压测栈（18083/15433），全程不触碰线上 18080/18081/5432。

| 场景 | 注入方式 | 观察 | 结果 |
|---|---|---|---|
| TC-FT-01 连接池耗尽 | 20 个 idle-in-transaction 占满 PG 连接 | health 401（活）、业务查询 **200**（Hikari 池内排队不雪崩）；清理后即恢复 | ✅ PASS |
| TC-FT-02 行锁慢查询 | 单行 FOR UPDATE 持锁 30s | 其他行查询 **200** 全程不受影响；锁释放后正常 | ✅ PASS |
| TC-FT-04 实例 kill -9 | kill -9 后端进程 | 探活死→重启→**RTO 10s** 业务查询 200 | ✅ PASS |
| TC-UP-02 坏迁移阻断 | `--spring.flyway.locations` 注入 V999 非法 SQL | Flyway DbMigrate ERROR → **应用拒绝启动**（无半升级）；还原后正常服务 | ✅ PASS |

- **产物**：`fault-drill/timeline-merged.jsonl`（全场景时间线）、`bad-migration-startup.log`（坏迁移阻断证据）、`fault-drill-run.sh`（可复跑脚本）
- 演练结束态：压测栈恢复正常（业务探活 200），演练临时库/进程全部清理

## 四、遗留与移交

1. **告警触达**：`SCHEMA_ALERT_WEBHOOK` 未配置（脚本已支持，失败时仅日志）——接入 IM webhook 属上线评审决策项
2. **每日备份 cron**：修复版脚本已部署，03:30 自动触发；建议上线评审时抽查次日产物大小（>100KB 方为有效）
3. **性能容量**：当前 4C/3.6G 单实例安全容量 100 VU；若试点用户量超此水位需垂直扩容后重测
4. **k6 脚本档案**：`docs/acceptance/M16/perf/` 双脚本可复跑（含资源采样器 `sample-resources.sh` 部署于服务器 `/opt/schema/staging/perf/`）
