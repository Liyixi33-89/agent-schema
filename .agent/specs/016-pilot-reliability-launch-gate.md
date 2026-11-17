---
spec_id: 016-pilot-reliability-launch-gate
status: active
milestone: M16              # 依赖图 §3 M16 行（L-Pilot 试点门禁任务）；前置 M15 accepted
created: 2026-11-13
last_verified_at: 2026-11-16
owner: human-lead
---

# Spec · M16 试点可靠性与上线门禁

> 真源：《详细PRD 11 · 企业级服务保障与上线验收》§2-§3（SLA/备份恢复/容量基线/G1-G7 操作级清单）；
> 《详细测试技术文档 03》§1-§6（250 并发压测模型/DR-01 演练脚本/TC-FT 01-06/TC-UP 01-04/G1-G7 证据物组织）；
> 《MVP开发任务依赖顺序图》§3 M16 行（备份恢复演练 + SLA 看板 + 告警触达值班演练 + 租户级健康页 + G7 复核 + 250 并发基线压测）；
> 台账验收项：pilot（备份恢复 RTO/RPO、250 并发、告警演练、健康页、G1-G7 与人工上线评审）。
> **所有数值指标（250 并发、P95 < 1.5s、错误率 < 0.5%、RTO ≤ 4h、RPO ≤ 15min、抽样一致率 ≥ 99.9%）均引自上述文档，本 spec 不新造指标。**

## 1. 背景与目标

M15 已 accepted（公网验收环境通过业务+安全双套件），但 **M15 通过 ≠ 生产上线批准**（workflow.md §自动化边界：
外部试点必须同时满足 M15/M16 accepted 和人工上线评审）。M16 是服务保障类收口任务：
把「平台承诺的服务等级」从文档变成**实测证据**——备份真的能恢复、250 并发真的扛得住、
告警真的能触达值班、健康页真的能反映状态；最后以 G1-G7 证据物 + 人工上线评审决定是否接入试点租户。

同时收口 M15 三项遗留：附件 uploader 注入（deferred 登记）、公网验收面驻留处置、临时隧道/nginx 配置清理。

**文档-实现对齐收口（2026-11-13，详见《docs/文档-代码实现对齐表.md》）**：
- 附件 uploader 闭环已随本 spec T1 实施（hostProps 注入 + presign 链）；
- 分步表单引擎（宿主步状态接管）、移动端 P1 保底（responsiveTransform）、flow-designer P1 只读画布
  三项能力缺口在对齐表 §4 DR-03/04/05 登记，**须 human-lead 批准分期或排期补齐后方可声明 M16 完成**；
- 选型漂移（自研 store/hash 路由/JSON 快照豁免等）以对齐表 §3 裁决为统一口径，架构总纲反模式条目补例外注记。

## 2. 范围声明

**做**：
- 附件 uploader 注入与浏览器上传交互验收（M15 deferred 项，runtime 宿主注入 uploader + FileUpload 物料真实上传）；
- 备份恢复演练 DR-01（数据库 + 附件对象存储 + 配置三层，隔离恢复环境完整恢复 + 抽样校验 ≥ 99.9% + RTO/RPO 实测归档）；
- 250 并发基线压测 PERF-01~05（预发布环境，70/20/10 混合配比，P95 < 1.5s / 错误率 < 0.5% / 资源水位）；
- 故障注入与告警演练 TC-FT 01-06（连接池耗尽/慢查询/下游超时/实例崩溃/告警分级路由/大盘可信性）；
- 升级回滚演练 TC-UP 01-04（滚动升级/应用回滚/schemaVersion 双端不同步/Flyway 迁移失败阻断）；
- 租户级健康页与 SLA 统计看板（10BE §4 契约消费，14FE §5a 触点）；
- G1-G7 证据物组织与 gate-lpilot-report.md（试点评审材料，五方会签位）;
- 人工上线评审（明确回滚条件、试点开放范围、批准人签发）;
- M15 遗留处置：公网验收面驻留（保留/下线决策）、临时隧道/nginx 配置清理。

**不做**（防范围蔓延）：
- 500 并发 L-GA 基线压测（G8 前执行，测试文档 03 §6 已登记为后续常态化）；
- 异地多活/多区域容灾（L-Enterprise 按客户触发）；
- 混沌工程平台引入（MVP 期故障注入用脚本化手段）；
- 生产环境压测（预发布环境同构规格推算容量）；
- 正式生产开放（本轮目标是「具备试点开放条件」，开放动作另行批准）；
- 法务条款定稿（G6 试点协议文本属法务交付物，登记占位）。

## 3. 指标基线（全部引自真源，禁止编造）

| 指标 | 阈值 | 出处 |
|---|---|---|
| 压测并发 | 250 VU（70% 读 / 20% 写 / 10% 发布） | PRD 11 §2.4 + 依赖图 M16 |
| P95 响应 | < 1.5s（单模型 100 万行高频查询 < 1s） | 测试文档 03 §1.1 + PRD 01 §5 |
| 错误率 | < 0.5%（分接口统计，禁止整体平均掩盖） | 测试文档 03 §1.2 PERF-01 |
| 资源水位 | CPU < 70%、内存无持续增长、连接池 < 80% | 测试文档 03 §1.1 |
| RTO | ≤ 4h（实测记录，不得仅记录后放行） | PRD 11 §2.2 + 测试文档 03 §2.2 |
| RPO | ≤ 15 分钟（WAL 归档粒度实测确认） | PRD 11 §2.2 |
| 抽样一致率 | ≥ 99.9%（随机 1000 行逐字段 + 全表行数 + Schema 版本表完整） | PRD 11 §3 G3 + 测试文档 03 §2.1 |
| 告警触达 | P0 < 5min 触达 + 分级路由正确（P0 电话/短信+IM，P1 仅 IM） | 测试文档 03 §3 TC-FT-05 |
| 健康页状态流转 | healthy → degraded → recovering 与注入时间线吻合 | 测试文档 03 §3 |

**环境要求**：与生产同构规格、同区域、独立数据库实例（测试文档 03 §1）。当前单服务器规格（腾讯云单节点 + 单 PG）
属**试点最小规格**，压测报告须如实登记规格偏差与推算结论，不得冒充生产同构。

## 4. Tasks

- [x] T1 附件 uploader 注入实现（M15 deferred 项闭环）：runtime 宿主注入 uploader 到 FileUpload 物料 props，浏览器真实上传交互验收（选择→上传→回显→提交落库→详情下载）——2026-11-13 完成（commit 8505602，accept-m16-attachment.cjs 30/30 PASS，修复受控回显/编辑态回填竞态/10MB 拦截三缺陷）
- [ ] T2 备份恢复演练 DR-01：三层备份取回 → 隔离环境完整恢复（计时）→ 抽样校验 → 冒烟子集 → 报告归档 → 演练环境销毁
- [ ] T3 压测环境搭建与 PERF-01~05 执行：k6 脚本（登录/Schema 拉取/CRUD/发布按配比）、预置 100 万行数据集、资源水位采集；报告含规格偏差声明
- [ ] T4 故障注入 TC-FT 01-06 与升级回滚 TC-UP 01-04：脚本化注入（kill/连接池/慢查询）、告警分级路由验证、Flyway 迁移失败阻断验证
- [x] T5 健康页与 SLA 看板接线（前端 + 后端聚合两部分）：
      后端聚合接口（2026-11-13，PR #18）：OpsController 四接口（overview/api-throughput/script-compile/recent-errors，org:manage 闸门）线上 18081 实测全通；修复 file_object size→size_bytes（ACTIVE 过滤）、successRate 零样本 null 的 Map.of NPE。
      前端接线（2026-11-16）：admin-console HealthTab 接入四聚合接口——状态卡片（活跃用户/吞吐/错误计数/编译成功率/存储）+ 吞吐时序 + 编译时序 + 近期错误事件表；处理无样本（窗口内无事件显式提示）、加载失败（可重试恢复）、无权限（403 转引导提示）、30s 自动刷新。状态展示严格按后端契约字段（db/status UP/DOWN/DEGRADED）渲染，前端不做 healthy/degraded/recovering 猜测转换（后端无此三态契约——测试文档 03 §3 的流转断言属注入期观察口径，非接口字段）。
      SLA 看板（2026-11-16）：后端补契约 `/api/ops/sla/monthly`（PRD11 §2.1 口径闭环：分钟采样连续 ≥5 才计不可用、维护窗口从分母扣除、零样本 availability=null 不用编译成功率代替）+ `/api/ops/sla/maintenance-windows`（72h 提前量/单次 ≤2h/每月 ≤1 次/紧急例外）+ V17 表（sla_minute_sample/ops_maintenance_window）+ sla.availability 入计量白名单；前端 SlaTab 纯展示后端口径（basis 字段可追溯）。
      **注入期间状态流转断言未完成——待 T4 故障注入时验证（healthy→degraded→recovering 为注入期健康页可见性观察口径，映射到 db/status 字段翻转）。**
      范围澄清（2026-11-13 对齐表 §2）：当前 HealthTab 是**平台级运维状态页**（/api/ops/health 平台/数据库/版本），
      不等于 PRD 09 §2.6 租户级健康页——租户错误率/失败构建清单/排障入口的聚合维度属本任务新增交付，
      不得以现有运维页冒充 G4 完成
- [x] T5a 静默校验缺陷修复（2026-11-13 轮发现的表单可用性缺陷，2026-11-16 修复）：必填字段不在布局时提交被静默拦截无反馈。修复三处——① schema-form validateAllDetailed 返回全部错误（非仅首个）+ SubmitResult.clientErrors 明细；② FormPageHost 提交失败时错误汇总区列出全部原因，布局外字段显式提示「不在页面中，请联系管理员」；③ 服务端 422 字段错误（含布局外字段）完整透传呈现。回归测试 3 例（form.test.ts 错误汇总 describe 块）。
- [ ] T6 G1-G7 证据物组织 + gate-lpilot-report.md：逐门禁引用证据物编号（G1/G2 引用 M15 归档、G3-G5 本轮产出、G6 登记占位、G7 引用 M14/M15 L2 记录）
- [ ] T7 M15 遗留处置：公网验收面驻留决策（human-lead）、临时隧道/nginx 配置清理（schema-accept-tunnel.conf、18097 配置）
- [ ] T8 独立审查 + 人工上线评审：四维审查报告、回滚条件明确、human-lead 签发上线批准（试点开放范围与时间点）；台账 M16 → accepted
- [ ] T9 服务器配置变更执行（隧道清理等）——**须 human-lead 确认执行窗口后另行操作，不在本 spec 内自行变更**

## 5. Acceptance

- [ ] A1 附件上传交互全链路通过（浏览器真实操作：选择→上传→回显→提交→详情下载，负例：超 10MB 拒绝）——M15 deferred 项闭环——已达成（2026-11-13 验收套件 30/30 PASS），随 M16 整体验收勾选
- [ ] A2 DR-01 演练完成：抽样一致率 ≥ 99.9%、RTO/RPO 实测值归档、演练环境销毁记录在案
- [ ] A3 PERF-01~05 全过（250 VU、P95 < 1.5s、错误率 < 0.5% 分接口、资源水位达标）；报告含环境规格表与基线对比结论（首次建立基线）
- [ ] A4 TC-FT 01-06 全过：P0/P1 告警分级路由正确、触达时延记录、大盘数据与注入时间线吻合；健康页状态流转正确
- [ ] A5 TC-UP 01-04 全过：滚动升级无感、Flyway 迁移失败阻断发布、schemaVersion 双端不同步时运行时拒渲染不白屏
- [ ] A6 gate-lpilot-report.md 出具：G1-G7 逐项附证据物编号（无编号视为未通过）；五方会签位（单人项目：human-lead 统一签发并登记）
- [ ] A7 verify[commit] 全绿；独立审查四维报告入归档；人工上线评审记录（批准人/回滚条件/试点范围）入归档；台账 M16 → accepted
- [ ] A8 M15 遗留处置完毕：附件 uploader 已闭环并入 A1；验收面驻留决策登记；隧道/nginx 配置清理完成或显式登记为保留原因
- [ ] A9 显式边界：正式生产开放不在本验收声明——上线评审通过仅代表「具备试点开放条件」，开放动作另行批准执行

## 6. 验证步骤

```text
1. python scripts/workflow.py start M16
2. T1 附件 uploader：本地浏览器验收（accept-m15-mvp.cjs 扩附件场景）后公网复核
3. T2 DR-01：备份取回→恢复→校验脚本执行，报告归档 docs/acceptance/M16/<run-id>/
4. T3 压测：k6 脚本执行 PERF-01~05，报告 EV-M16-PERF-* 归档
5. T4 故障注入：TC-FT/TC-UP 用例执行记录归档
6. powershell -File scripts/verify.ps1 commit
7. gate-lpilot-report.md + 独立审查 + 人工上线评审 → workflow.py accept M16
```

## 7. 沉淀记录（结项时回填）

- 2026-11-13 T1 附件闭环三缺陷（受控 fileList 吞 onSuccess/详情回填竞态/10MB 前端拦截缺失）修复经验入 commit 8505602 描述
- 2026-11-13 T5 实测两坑：① file_object 存储列名是 `size_bytes` 非 `size`（且按 status=ACTIVE 过滤——PENDING 未落盘/EXPIRED 已失效不计入）；② `Map.of` 不容 null——零样本 successRate 为 null 直接 NPE，可空字段组装用 LinkedHashMap。本地不暴露是因为本地库有序列存量/近期有编译样本，线上全新口径即刻触发
- 2026-11-13 CI-only 测试坑：PageServiceIT 显式插 `sys_user(id=1)` 后序列仍从 1 起，后续 `preview_operator` 自增插入撞主键——全新 PG（CI）才触发，本地有序列存量不复现；种子插入一律补 `ON CONFLICT DO NOTHING`
- 产品缺陷待登记（本轮发现）：必填字段不在布局时，提交被校验层静默拦截且无任何用户反馈（无 toast/无标红）——影响表单可用性，建议排入 M16 修复
  → **已修复（2026-11-16，T5a）**：错误汇总区 + 布局外字段显式提示 + 全量错误返回；回归测试入 form.test.ts

## 8. 上线门禁差距复核（2026-11-16）

下一任务为 T6 门禁证据核对，不重新执行已完成演练，不自行签发上线批准。台账 requirement 的 passed 不替代本 spec 全量 Acceptance。

| 门禁维度 | 已有证据入口 | 尚缺证据／决定 | 当前结论 |
|---|---|---|---|
| 业务与安全 | `docs/acceptance/M15/`；M14/M15 台账 | 核查部署版本差异及本轮变更影响，引用准确场景编号 | 待引用核对 |
| 数据库恢复 | `docs/acceptance/M16/dr-drill/`；**v2 全量：`dr-drill-v2/`（2026-11-17）** | ~~随机逐字段抽样、附件与配置恢复、实际 WAL/PITR 恢复覆盖须核查~~ → v2 已全部执行（含真实缺陷修复）；PITR 点位恢复登记运维手册项 | **A2 完整证据已有**（dr-drill-v2/DR-drill-v2-report.md） |
| 容量 | `docs/acceptance/M16/perf/`；**复验：`perf-reverify/`（2026-11-17）** | 250VU 如实未达标（150VU 已 FAIL）；分档资源时间线与发布独立 P95 已补 | A3 达标部分完成；**250VU 已裁决选 B**（2026-11-17：100VU 安全水位+单实例声明，250VU 随 Phase 2 多实例重验——PERF-reverify-report.md §3） |
| 故障与升级 | `docs/acceptance/M16/fault-drill/`；**映射真源：`TC-coverage-matrix.md`（2026-11-17）** | TC-FT/TC-UP 全量映射完成；连接池占满真实性已复核；**TC-FT-05 告警触达未执行（上线前阻断）**；TC-FT-03/TC-UP-01 架构性 N/A 已声明 | A4/A5 映射完成；**告警通道待接通** |
| 范围决议 | `docs/文档-代码实现对齐表.md` DR-03/04/05；**裁决材料：`pilot-scope-decision.md`（2026-11-17）** | 六项缺口 A/B/C 选项与代价已列明 | **已批准**（2026-11-17）：1=B/2=C+B/3=C/4=C（试点不含审批）/5=C/6=B——pilot-scope-decision.md §批准记录即试点范围边界真源 |
| 运维驻留 | T7/T9 | 验收面与隧道保留／清理决定、执行窗口与完成记录 | 待决定，禁止擅自清理 |
| 上线批准 | T8 | 独立审查、G1-G7 精确引用、试点范围、回滚条件、批准人 | 未批准 |

本节是差距核查清单，不是正式 gate-lpilot-report，不构成独立审查或 accepted 证据。后续核查须补入实际文件及场景编号，不仅引用目录。
**更新（2026-11-17）**：§T6 差距补齐执行结果（见本节末尾）已完成三线交付——A2 完整证据、A3 修正口径证据与 250VU 裁决请求、A4/A5 映射真源。**裁决更新（2026-11-17）**：250VU 已裁决选 B、试点范围六项已批准（见 §8 表）。仍开放阻断项：告警通道（TC-FT-05）、验收面去留（T7/T9）。

### T6 证据定位结果（2026-11-16）

- 完整代码门禁：本轮 `verify[commit]` 实际退出码 0，耗时约 129s，13 个已有 manifest 校验通过。此结果不代表 M16 演练目录已按 run-id/manifest 正式归档。
- 恢复证据：`docs/acceptance/M16/dr-drill/dr-drill-result.json`、`sample-check.json`、`source-baseline.json`、`precheck.json`、`dr-drill-run.log`。演练报告 §1.2 的 53/53 是表行数一致，不得代替随机 1000 行逐字段一致率；WAL 已开启及持续归档不单独证明 PITR 可恢复或端到端 RPO 已达标。三层恢复覆盖须逐项读结果核实。
- 容量证据：`docs/acceptance/M16/perf/k6-level50.json`、`k6-level100.json`、`k6-level150.json`、`k6-summary.json`、`resource-peak.json`。演练报告 §2.3 明确 150 VU 和 250 VU 超限；100 VU 的混合容量结论也不能替代单模型查询 <1s 和 CPU <70% 的分别验收。发布列缺值、非 2xx 豁免口径须以原始 summary 核对。
- 故障证据：`docs/acceptance/M16/fault-drill/timeline-merged.jsonl` 和 `bad-migration-startup.log` 对应 TC-FT-01/02/04、TC-UP-02；`fault-drill-run.sh` 为执行脚本，不是独立结果。连接池耗尽是否真实发生须核查连接限额与占用目标，不能由启动 20 条连接直接推断。
- 告警阻断：演练报告 §4 明确 webhook 未配置，仅日志；尚无实际接收、时延或分级路由证据，不可标 A4 全过。

当前核对仅引用已有报告并定位后续核查点，不改变台账 passed，不伪造审查结论，也不签发上线批准。下一步读取原始恢复与 k6 结果，校正报告结论与实测指标映射。

### T6 原始证据复核结果（2026-11-16）

1. DR-01 原始 JSON 的 sampleCheck 仅比较表行数，未记录随机行逐字段比较；`filesLayer` 只有指向日志的说明。日志明确附件源 0 个、备份 0 个，不能证明非空附件恢复或下载可用；未见配置恢复及恢复实例 HTTP 业务冒烟。`smoke` 仅四个标量，尚不证明业务链路。恢复库销毁与逻辑 dump 恢复有证据，A2 全量要求仍未完成。
2. 恢复计时需校准：原始 `rtoSeconds=3`、`rtoMinutes=0.1`，日志时间线约 4s；需明确计时边界与四舍五入口径。不可将小库 dump 灌入时间直接外推为真实服务恢复时间。
3. `k6-level100.json` 记录查询 P95 1228.87ms、写入 P95 1009.50ms，均小于 1500ms；错误率为 0，发布 check 569 次成功，但未导出发布独立延迟指标。不能由查询／写入结果推断发布延迟通过，也不能推断查询 <1s 通过。
4. k6 原始 thresholds 为布尔形态，其语义须结合导出脚本／k6 版本核对，不能把 false 直接解释为失败或通过；本次数值比较不替代实际进程退出码。
5. `resource-peak.json` 是 1192 个采样的汇总峰值（CPU 100%、内存 90.5%、连接 18），无分档时间关联，不能证明 100 VU 时 CPU <70% 或连接池 <80%。补充按运行档位关联资源时间线及连接池分母。

下一项安全可执行工作：核查本地演练脚本，补非空附件／配置恢复和随机逐字段校验的可重复检查；只准备脚本与测试，不擅自重跑服务器演练。压测补发布独立指标与分档资源映射，保留旧证据，不覆盖历史结果。

### T6 差距补齐执行结果（2026-11-17，用户指令「开始执行空缺内容，进行补充」）

三线交付全部完成，证据按 run 归档：

**一、恢复门禁（A2）——已完整执行（不再部分）**
- 演练：`scripts/acceptance/m16-relaunch/dr-drill-full.sh`（v2 全量脚本）；结果：`docs/acceptance/M16/dr-drill-v2/`（dr-drill-result-v2.json + rowfield-check.json + attachment-check.json + smoke-business.json + dr-drill-run.log + DR-drill-v2-report.md）
- 随机逐字段：抽样逐字段比对一致率 100%（0 差异），静态表（page_schema/meta_model/meta_field/sys_user/file_object/flyway）全量逐字段比对
- 非空附件：探针经真实 API（presign→PUT→complete）灌入 → 备份 → 恢复 → 11/11 sha256 一致 + 恢复实例下载内容哈希匹配
- 配置恢复：env 副本 → 恢复实例以副本启动成功（health 200）；敏感值不入证据
- 业务冒烟：独立实例 18095 四链路全通（登录/运行态页面/数据查询/附件下载）
- RTO 口径：T0=宣布灾难→T2=四链路冒烟全通，秒记录分钟换算；实测 0.1min（口径写入结果 JSON timingScope 字段）
- PITR/RPO：WAL 实测追加（pg_switch_wal 后 26→27）；精确 PITR 点位恢复如实登记 `pendingOutsideDrill`——不冒充已完成
- 失败与清理：EXIT trap 全路径清理；演练库销毁、实例停止、探针清理（含历史轮次残留 11 个）全部确认
- **真实缺陷修复**：pg_dump 恢复后表属主=postgres 致应用无权（旧演练从未启动实例故未暴露）→ 恢复操作规程补属主重赋步骤（脚本内置）

**二、容量门禁（A3）——修正口径复验完成，250VU 裁决请求已呈报**
- 脚本：`perf-reverify.js`（ramping 混合）+ `perf-level-steady.js`（50/100/150 定档）+ `perf-reverify-run.sh`/`perf-levels-run.sh`
- 结果：`docs/acceptance/M16/perf-reverify/`（levels-result.json + k6-level*.json + resources-*.csv 时间线 + PERF-reverify-report.md）
- 定档：50VU 全 PASS（query 338ms）；100VU 全 PASS（query 1037ms）；150VU 全 FAIL（2.5-2.7s，exit=99 如实保留）
- 发布独立 P95：50/100/150 各档独立导出（66/855/2658ms）
- 资源分档关联：1s 采样按档独立成文件；连接池分母澄清（Hikari max=10，PG 侧稳定 17，瓶颈为应用 CPU 非 PG 连接）
- 错误率口径：expectedStatuses 修正（旧轮 72.55% failed 为 csrf/health 401 与 304 的口径伪影）；本轮业务 check 全档 0 失败
- 250VU：如实登记不可达（150VU 已 FAIL）；裁决选项 A 扩容复验 / B 容量调整批准已写入报告 §3 待用户裁决——**禁止降阈值冒充 A3 全过**

**三、故障与升级门禁（A4/A5）——TC 全量映射完成**
- 映射真源：`docs/acceptance/M16/fault-drill/TC-coverage-matrix.md`（TC-FT 01-06 / TC-UP 01-04 逐项：PASS/PARTIAL/NOT-RUN/N-A + 证据引用 + 处置）
- TC-FT-01 连接池真实性复核：占 20 连接（>池上限两倍）期间业务 200/0s（池内排队不雪崩）、恢复自愈、清理后连接回落基线——「启动 20 连接」不再被质疑未真实占满
- TC-FT-05 告警触达：**仍未执行**——接收端凭据未配置，登记为上线前阻断项（脚本侧 webhook 告警位已就绪）
- TC-FT-03 下游超时 / TC-UP-01 滚动升级：单实例架构无注入点，判定不适用（N/A）并声明为 Phase 2 演练项——不冒充通过

**四、范围决议材料——已裁决（2026-11-17）**
- `docs/acceptance/M16/pilot-scope-decision.md`：六项缺口裁决生效——1 分步表单=B 入口限制 / 2 移动端=C+B 桌面端试点 / 3 流程画布=C / 4 流程服务=C（试点不含审批）/ 5 外部集成=C / 6 云存储=B 单实例声明；批准记录表即试点范围边界真源

**仍开放的阻断项（转入上线批准门禁）**：
1. TC-FT-05 告警通道接通（需接收端凭据）——上线前必须实测触达
2. ~~250VU 容量裁决~~ → 已裁决选 B（100VU 安全水位+单实例声明，PERF-reverify-report.md §3）
3. ~~试点范围六项裁决~~ → 已批准（pilot-scope-decision.md §批准记录）
4. 验收面/隧道去留决定（T7/T9 范畴，本轮未动）

本节执行结果构成 A2 完整证据 + A3 修正口径证据 + A4/A5 映射真源；**不构成上线批准**——独立审查与人工批准仍按 §8 门禁执行。
