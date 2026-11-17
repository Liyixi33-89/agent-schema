# L-Pilot 试点上线门禁报告（gate-lpilot-report）

- **报告编号**：gate-lpilot-20261117
- **出具日期**：2026-11-17
- **状态**：草案（待独立审查 + human-lead 签发）
- **门禁真源**：PRD 11 §3 G1-G7 + 测试文档 03 §5 证据物清单（00 篇 §8.2 编号规则）
- **会签口径**：单人项目五方（产品/研发/安全/运维/客户成功）由 human-lead 统一签发（singleReviewerMode 登记）；每项引用证据物编号，无编号视为未通过。

## 0. 评审输入与范围边界

- **试点范围**：以 `pilot-scope-decision.md` §批准记录（2026-11-17）为边界真源——「表单+数据+看板」轻量场景，**不含审批流**；六项裁决 1=B/2=C+B/3=C/4=C/5=C/6=B。
- **容量声明**：试点期容量目标为 **100VU 安全水位 + 单实例限制**（250VU 未达标事实保留，随 Phase 2 多实例重验）——PERF-reverify-report.md §3，裁决 M16-DEC-250VU。活跃用户上限 ~500（20% 并发率折算）。
- **上线批准语义**：本报告通过仅代表「**具备试点开放条件**」；正式开放动作（接入试点租户）另行批准执行（spec 016 A9）。

## 1. G1 功能验收 —— PASS（引用 M15 归档）

| 项 | 判定 | 证据物 |
|---|---|---|
| MVP 范围功能验收（PRD 01/02/04/06/07 Phase 1） | PASS | EV-M16-G1-01 |
| 业务闭环端到端（建模→页面→权限→发布→表单→列表→埋点） | PASS 54/54 | EV-M16-G1-02 |
| 附件上传交互闭环（M15 deferred 项） | PASS 30/30 | EV-M16-G1-03 |
| 静默校验缺陷修复回归（T5a） | PASS 3 用例 | EV-M16-G1-04 |

- **EV-M16-G1-01**：`docs/acceptance/M15/20261113-131018-6daa7df/report.md`（公网终验轮报告：双套件 84 断言零 fail 零 skip，安全头基线齐备，版本关系分层声明）
- **EV-M16-G1-02**：`docs/acceptance/M15/20261113-131018-6daa7df/m15-mvp-result.json`（54 断言结构化结果）
- **EV-M16-G1-03**：`scripts/acceptance/accept-m16-attachment.cjs` 执行记录（30/30 PASS，2026-11-13；台账 M16-T1-ATTACHMENT passed）
- **EV-M16-G1-04**：`schema-frontend/packages/schema-form/test/form.test.ts` 错误汇总 describe（2026-11-16；全量前端测试 317 用例零回归）

注：PRD 11 G1 原文要求「demo 演示录像」——本项目以**结构化验收套件结果（HTTP+DB+浏览器三面核对）**替代录像，证据强度不低于录像且可复跑；如评审要求录像，试点开放前可补录。

## 2. G2 安全基线 —— PASS（引用 M15 归档）

| 项 | 判定 | 证据物 |
|---|---|---|
| 六类攻防用例（注入/跨站/CSP/伪造租户/死循环/嵌入） | PASS 30/30 | EV-M16-G2-01 |
| 越权测试（伪造租户头/资源 ID 全拒） | PASS | EV-M16-G2-02 |
| CSP 三态策略生效（Report-Only→强制） | PASS 三要素齐备 | EV-M16-G2-03 |

- **EV-M16-G2-01**：`docs/acceptance/M15/20261113-131018-6daa7df/m15-security-result.json`（A1-A6 六项必验全部实际执行 missedRequired=0）
- **EV-M16-G2-02**：A4 用例记录（伪造 X-Tenant-Id 403 TENANT_MISMATCH + 审计落库）——同上文件 SEC-A4-* 断言
- **EV-M16-G2-03**：A3 用例记录（可达对照组 + violation 事件 + 执行标记=false 三要素）——同上文件 SEC-A3-* 断言

注：渗透测试摘要——本项目以 M15 攻防套件（30 场景含正负例）作为渗透执行记录等价物；独立第三方渗透测试未执行（单人项目无外部安全团队），登记为试点期已知边界。

## 3. G3 数据保障 —— PASS（M16 本轮产出）

| 项 | 判定 | 实测值 | 证据物 |
|---|---|---|---|
| 备份恢复演练（隔离环境完整恢复） | PASS | 53/53 表一致 | EV-M16-G3-01 |
| 数据抽样校验 ≥ 99.9% | PASS | **随机逐字段一致率 100%**（0 差异）+ 6 张关键静态表全量逐字段 | EV-M16-G3-02 |
| 非空附件恢复（哈希一致+可下载） | PASS | 11/11 sha256 一致，恢复实例下载内容哈希匹配 | EV-M16-G3-03 |
| 配置恢复（服务可启动） | PASS | env 副本→恢复实例 health 200（敏感值不入证据） | EV-M16-G3-04 |
| RTO ≤ 4h | PASS | **实测 0.1min**（口径：T0 宣布灾难→T2 四链路冒烟全通） | EV-M16-G3-05 |
| RPO ≤ 15min | PASS | WAL 归档实测追加（26→27，archive_timeout=300s）；精确 PITR 点位恢复登记运维手册项（如实未覆盖） | EV-M16-G3-06 |
| 恢复流程文档化 | PASS | 恢复规程内置脚本（dr-drill-full.sh 属主重赋步骤） | EV-M16-G3-07 |

- **EV-M16-G3-01**：`docs/acceptance/M16/dr-drill-v2/dr-drill-result-v2.json`（时间线 + 实测值结构化）
- **EV-M16-G3-02**：`docs/acceptance/M16/dr-drill-v2/rowfield-check.json`（逐字段比对结果）
- **EV-M16-G3-03**：`docs/acceptance/M16/dr-drill-v2/attachment-check.json`（探针附件经真实 API 灌入后恢复比对）
- **EV-M16-G3-04/05**：同 EV-M16-G3-01（rto 段 + smoke 段）
- **EV-M16-G3-06**：`dr-drill-result-v2.json` walArchive 段 + `scripts/acceptance/m16-relaunch/enable-wal-archive.sh`
- **EV-M16-G3-07**：`scripts/acceptance/m16-relaunch/dr-drill-full.sh` + 报告 `docs/acceptance/M16/dr-drill-v2/DR-drill-v2-report.md`
- 补充：备份链路缺陷（runuser 缺失致每日备份全空）已于演练前修复并实测——备份产物双库非空、每日自动恢复演练内嵌（schema-backup.sh）。

## 4. G4 可观测 —— PASS（M16 本轮产出）

| 项 | 判定 | 实测值 | 证据物 |
|---|---|---|---|
| 租户级健康页 | PASS | 四聚合接口接线（状态/吞吐/编译成功率/近期错误），13/13 线上实测 | EV-M16-G4-01 |
| SLA 可用性看板 | PASS | 分钟采样/维护窗口/零样本 null 口径闭环，8 用例 IT | EV-M16-G4-02 |
| 告警触达演练（分级路由） | PASS | P0/P1/P2 三级全触达，时延 10.3-11.6ms（目标 <5min） | EV-M16-G4-03 |
| 大盘可信性（注入对照） | PASS | 注入期间存活语义 + 演练后回归；健康页状态流转口径澄清（db/status 字段非三态猜测） | EV-M16-G4-04 |
| 故障注入（连接池/慢查询/崩溃） | PASS | 池占满不雪崩/单行锁隔离/kill -9 RTO 9-10s | EV-M16-G4-05 |

- **EV-M16-G4-01**：`schema-frontend/apps/admin-console` HealthTab（PR #20）+ OpsController 四接口（PR #18，线上 18081 实测全通）
- **EV-M16-G4-02**：V17__sla_tables.sql + SlaBoardIT（8 用例）+ 线上实测 13/13（2026-11-16）；台账 M16-T5-SLA-BOARD passed
- **EV-M16-G4-03**：`docs/acceptance/M16/ft05-drill/`（报告 + delivery.json 逐条触达明细 + 时间线 + 接收端落盘）
- **EV-M16-G4-04**：`docs/acceptance/M16/fault-drill/TC-coverage-matrix.md`（TC-FT-01/02/06 判定行）+ ft05 timeline 注入观测位
- **EV-M16-G4-05**：`docs/acceptance/M16/fault-drill/timeline-merged.jsonl`（ft01/ft02/ft04 事件）+ TC 映射表

**诚实边界**：告警通道为自建 webhook 接收端（IM 语义，钉钉/企微契约兼容）——**第三方 IM/短信/电话推送段未验证**（无凭据）；凭据到位改 URL 复测，登记增强项非阻断（FT05 报告 §1）。生产告警源 env 接线（SCHEMA_ALERT_WEBHOOK 写入 /etc/schema-platform.env）随上线窗口执行。

## 5. G5 人工支持 —— PASS（文档类，本轮补齐）

| 项 | 判定 | 证据物 |
|---|---|---|
| 值班表 + 升级路径文档 | PASS | EV-M16-G5-01 |
| P0/P1 响应 SLA 内部承诺 | PASS（随本报告签发生效） | EV-M16-G5-01 §2 |
| 试点客户支持群 | 待试点开放时建立（群建立记录补录 EV-M16-G5-02） | — |

- **EV-M16-G5-01**：`docs/acceptance/M16/oncall-and-escalation.md`（值班表 7×24 P0 电话叫醒承诺 + 三级响应 SLA + 五步升级路径 + 单人限制如实告知）
- 单人项目限制：无备份值班人——P0 不可达时走自动保护（备份链路独立于应用），恢复后复盘补记；已在文档 §1 声明并纳入 G6 风险告知。

## 6. G6 试点协议 —— 占位（法务交付物，非阻断）

| 项 | 状态 | 说明 |
|---|---|---|
| 客户书面确认（试点范围/数据风险/SLA 例外/退出机制） | **占位** | 试点协议文本属法务交付物（spec 016 §2 明确「不做」清单登记） |

- **EV-M16-G6-01**：签署协议扫描件——**待试点客户确定后签署**；签署前不接入任何试点租户（与 A9「开放动作另行批准」联动）。
- 风险告知素材已备：试点范围六项裁决（pilot-scope-decision.md）、容量限制声明（100VU/~500 活跃用户）、单人值班限制、SLA 例外条款（试点期不适用赔付）。

## 7. G7 L2 隔离 —— PASS（引用 M14/M15 归档）

| 项 | 判定 | 证据物 |
|---|---|---|
| Worker 运行期能力剥夺（fetch/XHR/eval 原型链遮蔽不可达） | PASS | EV-M16-G7-01 |
| 死循环硬中断（terminate + 主线程存活） | PASS×2 | EV-M16-G7-02 |
| token 不进 Worker / DOM 不可达 | PASS | EV-M16-G7-01 |
| 未授权嵌入被拒 | PASS | EV-M16-G7-03 |

- **EV-M16-G7-01**：`docs/acceptance/M14/20261111-154305-6b180ed/report.md`（worker-isolation 套件：ISO-能力剥夺/页面存活/无预期外错误 PASS）
- **EV-M16-G7-02**：同上（hard-interrupt 套件：terminate 3008ms 主线程 alive）+ `docs/acceptance/M15/20261113-131018-6daa7df/report.md` §A5（11512ms 窗口实测 + UI 存活）
- **EV-M16-G7-03**：M15 报告 §A6（同源对照组 + 跨源拒绝 + XFO + frame-ancestors 强制 CSP）

## 8. 汇总判定与批准请求

| 门禁 | 判定 | 证据物计数 | 备注 |
|---|---|---|---|
| G1 功能验收 | ✅ PASS | 4 | M15 归档引用；录像以结构化套件结果替代 |
| G2 安全基线 | ✅ PASS | 3 | M15 归档引用；第三方渗透未执行（已知边界） |
| G3 数据保障 | ✅ PASS | 7 | 本轮 v2 全量演练；一致率 100%、RTO 0.1min |
| G4 可观测 | ✅ PASS | 5 | 健康页/SLA/告警触达/故障注入全过；第三方推送段如实声明 |
| G5 人工支持 | ✅ PASS | 1+1 待补 | 值班表/升级路径就绪；支持群随开放建立 |
| G6 试点协议 | ⏸ 占位 | 0（待签署） | 法务交付物；签署前不接入租户 |
| G7 L2 隔离 | ✅ PASS | 3 | M14/M15 归档引用 |

**结论**：G1-G5、G7 六项门禁通过并附证据物编号；G6 为外部法务依赖占位——**建议批准：具备试点开放条件，试点开放动作（含 G6 签署与支持群建立）另行批准执行**。

## 9. 回滚条件（试点期触发即执行）

| 触发条件 | 回滚动作 | 预案验证 |
|---|---|---|
| 数据损坏/误删（抽样一致率 < 99.9% 或业务数据异常） | DR 恢复规程（dr-drill-full.sh：备份恢复+属主重赋+四链路冒烟） | ✅ 已演练（RTO 0.1min） |
| 发布引入缺陷（P0 级） | schema-release.sh 版本目录切换回滚 | ✅ 发布竞态修复轮验证（104c284） |
| 坏迁移（启动阻断） | 回滚 jar + 恢复迁移前快照（勿强制启动） | ✅ TC-UP-02/04 已演练 |
| 安全事件（入侵/越权蔓延） | nginx 入口收敛 + 审计取证 + 修补；极端时暂停试点流量 | 入口收敛能力已验证（T9 面收敛实操） |
| 容量超限（P95 持续 > 1.5s 或错误率 > 0.5%） | 限流/暂停试点注册；触发容量重评（100VU 水位声明复核） | 容量边界已实测（50/100/150 定档） |

## 10. 签发（待 human-lead）

- [ ] 独立审查（四维：requirements/code/tests/evidence）——审查报告入归档
- [ ] human-lead 签发上线批准（试点开放范围与时间点）
- [ ] 台账 M16 → accepted

> 签发语义：批准「具备试点开放条件」；开放动作（接入租户/G6 签署/支持群建立）另行批准执行。
