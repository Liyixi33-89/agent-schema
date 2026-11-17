# M16 上线门禁独立审查报告（gate-lpilot-report 复核）

- **审查编号**：audit-lpilot-20261117
- **审查性质**：independent-session 四维审查（requirements / code / tests / evidence）——与 M16 实施轮分离，按 spec 016 §T8 要求执行
- **审查对象**：`docs/acceptance/M16/gate-lpilot-report.md`（gate-lpilot-20261117）及其引用的全部证据物
- **审查方法**：逐证据物编号核对原始文件（不采信二级转述）；代码抽查关键实现路径；结果文件结构化解析断言计数；服务器侧实测复核（SSH 直连，隔离栈，不碰生产 18080/5432）
- **审查边界**：不签发上线批准（human-lead 权限）；不改变台账 passed 状态；发现虚报时先补证后定性

## 一、四维审查结论

### 1. Requirements（需求覆盖）

| 范围 | 结论 |
|---|---|
| spec 016 §3 指标基线逐项 | G3（RTO 0.1min/RPO WAL 实测/抽样一致率）、G4（告警触达时延/健康页/SLA）、G5（值班表/升级路径）均有原始产物支撑 |
| 四项裁决（M16-DEC-250VU/PILOT-SCOPE/FT05-CHANNEL/T7T9） | 裁决文件与台账 decisions 一致，批准人/日期/引用真源齐备 |
| 回滚条件（gate 报告 §9） | 五类触发条件均附已演练预案与验证记录，无空泛表述 |
| **判定** | **通过**（附 F1 证据修正，见下） |

### 2. Code（代码抽查）

| 抽查点 | 结论 |
|---|---|
| `scripts/acceptance/m16-relaunch/dr-drill-full.sh` | 属主重赋步骤真实存在（恢复缺陷修复落地）；**但发现 F1 缺陷并已修复**（详见 §二） |
| `ft05-drill.sh` + `ft05-webhook-recv.py` | 自建接收端真实 HTTP 落盘、钉钉/企微契约兼容声明与实现一致；首轮 FAIL 产物如实保留（可追溯） |
| `accept-m16-attachment.cjs`（commit 8505602） | 391 行真实套件存在，三缺陷修复与 commit message 一致 |
| **判定** | **通过**（F1 修复后） |

### 3. Tests（测试结果核对）

| 套件 | 结果文件核对 |
|---|---|
| M15 安全 30/30 | `m15-security-result.json` 解析：30 断言、0 fail（EV-M16-G2-01 ✅） |
| M15 MVP 54/54 | `m15-mvp-result.json` 解析：54 断言、0 fail（EV-M16-G1-02 ✅） |
| SLA 看板 8 用例 + 线上 13/13 | 台账登记与 PR #18/#20 合并记录一致（EV-M16-G4-01/02 ✅） |
| FT05 三合一 3/3 | `ft05-delivery.json` 逐条 delivered=true，时延 10.3/11.6/10.4ms（EV-M16-G4-03 ✅） |
| **判定** | **通过** |

### 4. Evidence（证据物存在性与准确性）

23 项证据物编号全部核对：EV-M16-G1/G2/G3/G4/G5/G7 引用文件 100% 存在；G6 占位声明如实（法务依赖，非阻断）。

**发现 1 项证据准确性缺陷（F1）**，已处置闭环：

## 二、F1：DR-v2 静态表比对虚报（已修复+补证）

### 缺陷事实

`dr-drill-v2/rowfield-check.json` 中 6 张静态表（page_schema/meta_model/meta_field/sys_user/file_object/flyway_schema_history）比对全部带 `error` 字段——**比对命令实际执行失败，未产生任何比对结果**。但：

1. `DR-drill-v2-report.md` 声称「6 张关键静态表全量比对 ✅ 一致率 100%」
2. `gate-lpilot-report.md` G3 行引用「静态表全量逐字段比对」PASS
3. `TC-coverage-matrix.md` TC-UP-04 行声称「flyway_schema_history 全量比对 0 差异」

首轮 `consistencyRate=1.0` 仅基于 biz_model_1 的 10 行采样——静态表比对失败被 except 静默吞掉后，一致率按残余样本照常计算为 100%，构成**结构性虚报**（非有意造假，属缺陷吞错——脚本 except 分支只记 error 不阻断）。

### 根因（服务器实测定位）

`dr-drill-full.sh` 的 `q()` 把 SQL 塞进 `su - postgres -c 'psql ... -Atc "SQL"'` 双引号内层；静态表查询 SQL 自身含单引号（`'public'`/`'page_schema'`）与列名逗号拼串，经三层 shell 解析被拆断。biz_model_* 段因 SQL 形态简单未触发。

### 处置（2026-11-17 审查轮执行）

1. **脚本修复**（`scripts/acceptance/m16-relaunch/dr-drill-full.sh`）：
   - `q()` 改为 SQL 写全局可读临时文件经 `psql -f` 执行——完全规避嵌套引号解析
   - 静态表 except 分支补 `sys.exit(5)` 显式失败——比对失败必须阻断，不允许带 error 继续算一致率（吞错即虚报的根修复）
2. **补验执行**（服务器隔离栈，新鲜备份→恢复→立即比对，复刻 DR 演练验证步骤）：
   - 产物：`dr-drill-v2/static-verify-fresh.json`（已入库）
   - 结果：**六静态表 + biz_model_* 全量 211 行、0 差异、一致率 100%**——静态表逐字段一致性补证成立
   - 中间轮差异归因：对旧备份（11:49 时点）比对出现的 14 行差异全部为备份后源库正常写入（登录活动 last_login_at、DR 演练自身附件探针 ACTIVE→EXPIRED 状态流转、演练新增页面行），备份时点一致性由新鲜备份轮证明
3. **证据修正**：DR-v2 报告与 gate 报告 G3 的静态表表述补注 F1 修正（本轮提交）；原 rowfield-check.json 保留不删（虚报痕迹可追溯）

### F1 定性

**阻断级发现，已闭环**。补验证明静态表一致性实质成立（211 行 0 差异），原虚报属脚本吞错而非数据问题；修复后脚本消除再次发生路径。审查结论因此可以从「发现虚报」转为「虚报已修正且实质达标」。

## 三、次要发现（非阻断，登记）

| # | 发现 | 处置 |
|---|---|---|
| NF1 | 压测 100VU 档 query P95=1037ms，逼近 1500ms 阈值（余量 31%）且 CPU 峰值 100%（瞬时）——试点期容量水位需监控兜底 | 已由裁决 B 声明 100VU 安全水位；建议试点期接入容量告警（P95 持续>1.2s 预警） |
| NF2 | G5 值班表「P0 电话叫醒」依赖第三方凭据，当前仅自建 IM 语义通道 | FT05 报告 §1 已如实声明；凭据到位改 URL 复测（增强项非阻断） |
| NF3 | 精确 PITR 点位恢复未演练（仅 WAL 追加证明） | 已登记 pendingOutsideDrill 运维手册项；不冒充已覆盖 |
| NF4 | TC-FT-03/TC-UP-01 架构性 N/A（单实例无注入点） | pilot-scope-decision 项 6 单实例声明联动，Phase 2 补演练——豁免有据 |

## 四、审查判定

**四维审查通过（附 F1 闭环）**：

- G1 功能验收：PASS（M15 归档 84 断言零 fail，结构化结果替代录像——证据强度不低于且可复跑）
- G2 安全基线：PASS（30/30 实际执行，missedRequired=0；第三方渗透未执行为如实边界）
- G3 数据保障：PASS（F1 补验后：新鲜备份恢复 211 行 0 差异 + 附件 11/11 sha256 + RTO 0.1min + 配置恢复实测）
- G4 可观测：PASS（健康页/SLA 线上实测 + 告警 3/3 触达 ~10ms；第三方推送段如实未验证）
- G5 人工支持：PASS（值班表/升级路径/SLA 承诺齐备；支持群随开放补录）
- G6 试点协议：占位（法务依赖，签署前不接入租户——与 A9 联动，非阻断）
- G7 L2 隔离：PASS（M14/M15 归档引用核实）

**建议**：gate-lpilot-report 所列七维度门禁实质达成，建议 human-lead 签发上线批准（试点开放范围与时间点由 human-lead 决定；开放动作另行批准执行）。

## 五、审查产物

- 本报告：`docs/acceptance/M16/independent-review-lpilot.md`
- F1 补验产物：`docs/acceptance/M16/dr-drill-v2/static-verify-fresh.json`
- F1 脚本修复：`scripts/acceptance/m16-relaunch/dr-drill-full.sh`（q() 文件通道 + except 显式失败）
- 服务器补验留存：`/opt/schema/staging/dr-static-recheck-final/`（三轮产物与恢复日志）；演练库已全部销毁（pg_database 核查无 dr_* 残留）
